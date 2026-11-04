//! The library MCP: a loopback server whose tools read the library straight from its
//! files, never through the webview, and write only through the board session when a
//! switch allows it (`writes`). Also the bring-up the dev harness (`mcp`) shares.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::model::{CallToolResponse, CallToolResult};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{tool, tool_router, ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wslib_mcp::http::{self, ClientPolicy, HostPolicy, HttpConfig};
use wslib_mcp::result::{internal_error, ok_json, tool_error};
use wslib_mcp::rmcp;
use wslib_mcp::router::{compose, mark_read_only};
use wslib_mcp::server::{ServerIdentity, ToolServer};
use wslib_mcp::CancellationToken;
use wslib_secret::{Encoding, Secret};

use crate::board_store::board_db::peek_board;
use crate::board_store::board_index::{summaries, BoardSummary};
use crate::board_store::open_read_only;
use crate::library_index::{run_search, DocHit};
use crate::perf::Size;
use crate::schema::{Board, Card, CardKind};

pub(crate) mod lifecycle;
mod writes;

pub(crate) use writes::Host;

pub(crate) const PORT: u16 = 8793;

/// Which of the write switches are on.
#[derive(Clone, Copy, Default)]
pub(crate) struct Allowed {
  pub(crate) add: bool,
  pub(crate) edit: bool,
}

pub(crate) fn start(
  library: PathBuf,
  host: Arc<dyn Host>,
  allowed: Allowed,
  port: u16,
  token: String,
) -> Result<Listening, String> {
  let tools = LibraryTools { library, host };
  let router = Arc::new(LibraryTools::router(allowed));
  let identity = LibraryTools::identity(allowed);
  serve_loopback(port, token, move || ToolServer::new(tools.clone(), router.clone(), identity.clone()))
}

/// Binds now, so a taken port is an error here rather than a server on another port.
pub(crate) fn serve_loopback<S: ServerHandler + Send + 'static>(
  port: u16,
  token: String,
  factory: impl Fn() -> S + Send + Sync + 'static,
) -> Result<Listening, String> {
  let listener = http::bind_with_retry(SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(2))
    .map_err(|e| e.to_string())?;
  let config = HttpConfig {
    bearer_token: Some(token),
    allowed_hosts: HostPolicy::Loopback,
    allowed_clients: ClientPolicy::Loopback,
    allowed_origins: http::loopback_origins(port),
    ..HttpConfig::default()
  };
  let cancel = CancellationToken::new();
  let stop = cancel.clone();
  let (served, stopped) = mpsc::channel::<()>();
  tauri::async_runtime::spawn(async move {
    let _served = served;
    if let Err(e) = http::serve(listener, factory, config, stop).await {
      log::warn!("[mcp] server on {port} stopped: {e}");
    }
  });
  Ok(Listening { cancel, stopped })
}

/// Dropping one leaves the server running.
pub(crate) struct Listening {
  cancel: CancellationToken,
  stopped: mpsc::Receiver<()>,
}

impl Listening {
  /// Whether the server let go of its port and closed its connections within `wait`.
  /// Call it off the async workers: blocking the one that cancelled starves the shutdown.
  pub(crate) fn stop(self, wait: Duration) -> bool {
    self.cancel.cancel();
    self.stopped.recv_timeout(wait) != Err(RecvTimeoutError::Timeout)
  }
}

pub(crate) fn random_token() -> Result<Secret, String> {
  Secret::random::<24>(Encoding::Base64Url).map_err(|e| e.to_string())
}

#[derive(Clone)]
struct LibraryTools {
  library: PathBuf,
  host: Arc<dyn Host>,
}

impl LibraryTools {
  fn router(allowed: Allowed) -> ToolRouter<Self> {
    let mut read = Self::read_router();
    mark_read_only(&mut read);
    let add = allowed.add.then(|| writes::not_destructive(Self::add_router()));
    let edit = allowed.edit.then(|| writes::not_destructive(Self::edit_router()));
    metered(compose(read, [add, edit]))
  }

  fn identity(allowed: Allowed) -> ServerIdentity {
    let reads = "the Conspiracy library: its boards, their cards, connections and clusters, and the text \
                 extracted from imported files.";
    let instructions = match allowed {
      Allowed { add: false, edit: false } => format!("Read-only access to {reads} Nothing here changes the library."),
      Allowed { add, edit } => {
        let may: Vec<_> = [
          add.then_some("add to it: import files from disk, and create cards, connections, clusters and boards"),
          edit.then_some("edit it: change cards, their positions and clusters, connections, clusters and board titles"),
        ]
        .into_iter()
        .flatten()
        .collect();
        format!(
          "Access to {reads} You may also {}. Nothing here deletes anything. An edit to the board open in \
           the app can be undone there.",
          may.join(", and ")
        )
      }
    };
    ServerIdentity::new("conspiracy-library", wslib_build_id::build_version!())
      .with_title("Conspiracy library")
      .with_instructions(instructions)
  }

  async fn answer<T: Serialize + Send + 'static>(
    &self,
    read: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
  ) -> Result<CallToolResult, ErrorData> {
    let library = self.library.clone();
    respond(tauri::async_runtime::spawn_blocking(move || read(&library)).await)
  }

  async fn write<T: Serialize + Send + 'static>(
    &self,
    write: impl FnOnce(&dyn Host) -> Result<T, String> + Send + 'static,
  ) -> Result<CallToolResult, ErrorData> {
    let host = self.host.clone();
    respond(tauri::async_runtime::spawn_blocking(move || write(&*host)).await)
  }
}

/// Times every call as `mcp:<tool>`, with the bytes of its answer.
fn metered<S: Send + Sync + 'static>(mut router: ToolRouter<S>) -> ToolRouter<S> {
  for route in router.map.values_mut() {
    let call = route.call.clone();
    let name: Arc<str> = format!("mcp:{}", route.attr.name).into();
    route.call = Arc::new(move |ctx: ToolCallContext<'_, S>| {
      let (start, answer, name) = (Instant::now(), call(ctx), name.clone());
      Box::pin(async move {
        let answer = answer.await;
        crate::perf::record(&name, start.elapsed(), Size { bytes: answer_bytes(&answer), ..Size::default() });
        answer
      })
    });
  }
  router
}

fn answer_bytes(answer: &Result<CallToolResponse, ErrorData>) -> u32 {
  let Ok(CallToolResponse::Complete(result)) = answer else { return 0 };
  let bytes: usize = result.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.len()).sum();
  bytes.try_into().unwrap_or(u32::MAX)
}

fn respond<T: Serialize, E: std::fmt::Display>(done: Result<Result<T, String>, E>) -> Result<CallToolResult, ErrorData> {
  match done {
    Ok(Ok(value)) => ok_json(value),
    Ok(Err(e)) => Ok(tool_error(e)),
    Err(e) => Err(internal_error(e.to_string())),
  }
}

#[derive(Deserialize, JsonSchema)]
struct BoardArgs {
  board_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct CardsArgs {
  board_id: String,
  /// One of person, organisation, document, email, message, call, event or evidence.
  #[schemars(with = "Option<String>")]
  kind: Option<CardKind>,
  /// Keep only cards whose title or notes contain this, ignoring case.
  text: Option<String>,
  /// At most this many cards (default 50).
  limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct CardArgs {
  board_id: String,
  card_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SearchArgs {
  query: String,
  /// At most this many hits (default 20).
  limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct MediaArgs {
  /// The media file's name, as a card or a search hit gives it.
  name: String,
}

#[tool_router(router = read_router)]
impl LibraryTools {
  #[tool(description = "Every board in the library, newest first: id, title and when it last changed.")]
  async fn list_boards(&self) -> Result<CallToolResult, ErrorData> {
    self.answer(|library| Ok(json!({ "boards": boards(library)? }))).await
  }

  #[tool(description = "One board's title and how many cards, connections and clusters it holds.")]
  async fn board_summary(&self, Parameters(args): Parameters<BoardArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| board_summary(library, &args.board_id)).await
  }

  #[tool(description = "A board's cards in brief (id, kind, title, date, clusters), optionally filtered by \
                        kind or text. `total` counts every match, before the limit.")]
  async fn list_cards(&self, Parameters(args): Parameters<CardsArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| cards(library, &args)).await
  }

  #[tool(description = "One card in full: notes, kind payload, media files and all.")]
  async fn get_card(&self, Parameters(args): Parameters<CardArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| card(library, &args.board_id, &args.card_id)).await
  }

  #[tool(description = "A board's connections: the strings between its cards, with label, kind and grade.")]
  async fn list_connections(&self, Parameters(args): Parameters<BoardArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| Ok(json!({ "connections": board(library, &args.board_id)?.connections }))).await
  }

  #[tool(description = "A board's clusters. A card names the clusters it belongs to in `clusterIds`.")]
  async fn list_clusters(&self, Parameters(args): Parameters<BoardArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| Ok(json!({ "clusters": board(library, &args.board_id)?.clusters }))).await
  }

  #[tool(description = "Full-text search over the text extracted from every imported file, best first. Each \
                        hit names the media file, a snippet, and the cards that carry it.")]
  async fn search_library(&self, Parameters(args): Parameters<SearchArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| search(library, &args.query, args.limit.unwrap_or(20))).await
  }

  #[tool(description = "The text extracted from one media file, and its index status.")]
  async fn media_text(&self, Parameters(args): Parameters<MediaArgs>) -> Result<CallToolResult, ErrorData> {
    self.answer(move |library| media_text(library, &args.name)).await
  }

  #[tool(description = "How long the app's commands, these tools and the board's own steps took since launch or \
                        the last reset: per operation the count and the p50, p95, max and last in ms, slowest \
                        first; then the 50 slowest calls with their sizes (rows in and out, bytes emitted).")]
  async fn perf_report(&self) -> Result<CallToolResult, ErrorData> {
    ok_json(crate::perf::report())
  }
}

fn index(library: &Path) -> Result<rusqlite::Connection, String> {
  open_read_only(&library.join("library.sqlite"))
}

fn boards(library: &Path) -> Result<Vec<BoardSummary>, String> {
  summaries(&index(library)?)
}

fn board(library: &Path, id: &str) -> Result<Board, String> {
  peek_board(&library.join("boards"), id)?.ok_or_else(|| format!("No board {id:?}."))
}

fn board_summary(library: &Path, id: &str) -> Result<Value, String> {
  let board = board(library, id)?;
  Ok(json!({
    "id": id,
    "title": board.meta.title,
    "updatedAt": board.meta.updated_at,
    "cards": board.cards.len(),
    "connections": board.connections.len(),
    "clusters": board.clusters.len(),
  }))
}

fn cards(library: &Path, args: &CardsArgs) -> Result<Value, String> {
  let board = board(library, &args.board_id)?;
  let text = args.text.as_deref().map(str::to_lowercase);
  let matches: Vec<_> = board
    .cards
    .iter()
    .filter(|c| args.kind.is_none_or(|k| c.kind == k))
    .filter(|c| {
      text.as_deref().is_none_or(|t| c.title.to_lowercase().contains(t) || c.notes.to_lowercase().contains(t))
    })
    .collect();
  let brief: Vec<_> = matches
    .iter()
    .take(args.limit.unwrap_or(50))
    .map(|c| {
      json!({ "id": c.id, "kind": c.kind, "title": c.title, "occurredAt": c.occurred_at, "clusterIds": c.cluster_ids })
    })
    .collect();
  Ok(json!({ "total": matches.len(), "cards": brief }))
}

fn card(library: &Path, board_id: &str, card_id: &str) -> Result<Card, String> {
  let board = board(library, board_id)?;
  board.cards.into_iter().find(|c| c.id == card_id).ok_or_else(|| format!("No card {card_id:?}."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CardRef {
  board_id: String,
  card_id: String,
  title: String,
}

#[derive(Serialize)]
struct SearchHit {
  #[serde(flatten)]
  hit: DocHit,
  cards: Vec<CardRef>,
}

fn search(library: &Path, query: &str, limit: u32) -> Result<Value, String> {
  let hits = run_search(&index(library)?, query, limit)?;
  let mut found: Vec<SearchHit> = hits.into_iter().map(|hit| SearchHit { hit, cards: Vec::new() }).collect();
  for summary in boards(library)? {
    let Ok(Some(board)) = peek_board(&library.join("boards"), &summary.id) else { continue };
    for card in &board.cards {
      for found in found.iter_mut().filter(|f| card.media_files().any(|m| m == f.hit.name)) {
        found.cards.push(CardRef { board_id: summary.id.clone(), card_id: card.id.clone(), title: card.title.clone() });
      }
    }
  }
  Ok(json!({ "hits": found }))
}

fn media_text(library: &Path, name: &str) -> Result<Value, String> {
  let (status, text): (String, Option<String>) = index(library)?
    .query_row(
      "SELECT d.status, f.body FROM documents d LEFT JOIN doc_fts f ON f.rowid = d.id WHERE d.name = ?1",
      [name],
      |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| match e {
      rusqlite::Error::QueryReturnedNoRows => format!("{name:?} is not in the search index."),
      e => format!("Could not read the search index: {e}"),
    })?;
  Ok(json!({ "name": name, "status": status, "text": text }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::board_db::create_board_db;
  use crate::board_store::board_index::upsert_summary;
  use crate::board_store::temp_dir_for;
  use crate::extract::ExtractOutcome;
  use crate::library_index::{open_at, write_outcome};
  use crate::schema::parse_board;

  fn fixture_card(id: &str, title: &str, kind: &str, extra: Value) -> Value {
    let mut card = json!({ "id": id, "title": title, "kind": kind, "clusterIds": ["g"], "position": { "x": 0, "y": 0 } });
    card.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    card
  }

  pub(super) fn library(name: &str) -> PathBuf {
    let dir = temp_dir_for(name);
    let db = open_at(&dir).unwrap();
    let mut conn = db.lock_db().unwrap();
    let board = parse_board(json!({
      "version": 4,
      "meta": { "title": "Acme", "updatedAt": "2026-01-02T00:00:00.000Z" },
      "clusters": [{ "id": "g", "label": "Money", "color": "#f00", "visible": true }],
      "cards": [
        fixture_card("p", "Jane Roe", "person", json!({ "notes": "Director of Acme" })),
        fixture_card("d", "Ledger", "document", json!({ "document": { "file": "aa.pdf" } })),
        fixture_card("e", "Meeting", "event", json!({ "notes": "Jane meets the auditor" })),
      ],
      "connections": [{ "id": "c", "source": "p", "target": "d", "label": "signed" }],
    }))
    .unwrap();
    create_board_db(&dir.join("boards/brd_acme.sqlite"), &board).unwrap();
    upsert_summary(&conn, "brd_acme", "Acme", "2026-01-02T00:00:00.000Z").unwrap();
    let tx = conn.transaction().unwrap();
    write_outcome(&tx, "aa.pdf", 10, &ExtractOutcome::Text("quarterly ledger of offshore payments".into())).unwrap();
    write_outcome(&tx, "bb.png", 10, &ExtractOutcome::Unsupported).unwrap();
    tx.commit().unwrap();
    dir
  }

  fn cards_where(library: &Path, kind: Option<CardKind>, text: Option<&str>, limit: Option<usize>) -> Value {
    let args = CardsArgs { board_id: "brd_acme".into(), kind, text: text.map(String::from), limit };
    cards(library, &args).unwrap()
  }

  fn ids(cards: &Value) -> Vec<&str> {
    cards["cards"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect()
  }

  #[test]
  fn the_tools_listed_are_the_reads_and_what_the_switches_allow_and_none_deletes() {
    const READ: [&str; 9] = [
      "board_summary",
      "get_card",
      "list_boards",
      "list_cards",
      "list_clusters",
      "list_connections",
      "media_text",
      "perf_report",
      "search_library",
    ];
    const ADD: [&str; 5] = ["create_board", "create_card", "create_cluster", "create_connection", "import_file"];
    const EDIT: [&str; 5] = ["move_cards", "rename_board", "update_card", "update_cluster", "update_connection"];
    for (add, edit) in [(false, false), (true, false), (false, true), (true, true)] {
      let listed: Vec<_> = LibraryTools::router(Allowed { add, edit })
        .list_all()
        .into_iter()
        .map(|t| {
          let hints = t.annotations.map(|a| (a.read_only_hint, a.destructive_hint));
          (t.name.to_string(), hints)
        })
        .collect();
      let reads = READ.map(|name| (name, Some((Some(true), None))));
      let writes = [(add, ADD), (edit, EDIT)].into_iter().filter(|(on, _)| *on).flat_map(|(_, names)| names);
      let mut expected: Vec<_> = reads
        .into_iter()
        .chain(writes.map(|name| (name, Some((Some(false), Some(false))))))
        .map(|(name, hints)| (name.to_string(), hints))
        .collect();
      expected.sort();
      assert_eq!(listed, expected, "add {add}, edit {edit}");
    }
  }

  #[test]
  fn boards_and_their_contents_read_from_the_files() {
    let dir = library("mcp-boards");
    let listed = serde_json::to_value(boards(&dir).unwrap()).unwrap();
    assert_eq!(listed, json!([{ "id": "brd_acme", "title": "Acme", "updatedAt": "2026-01-02T00:00:00.000Z" }]));
    assert_eq!(
      board_summary(&dir, "brd_acme").unwrap(),
      json!({ "id": "brd_acme", "title": "Acme", "updatedAt": "2026-01-02T00:00:00.000Z", "cards": 3, "connections": 1, "clusters": 1 })
    );
    let full = card(&dir, "brd_acme", "d").unwrap();
    assert_eq!(full.document.unwrap().file.as_deref(), Some("aa.pdf"));
    let board = board(&dir, "brd_acme").unwrap();
    assert_eq!(board.connections[0].label.as_deref(), Some("signed"));
    assert_eq!(board.clusters[0].label, "Money");
    assert!(card(&dir, "brd_acme", "nope").is_err());
    assert!(board_summary(&dir, "brd_gone").is_err());
    assert!(board_summary(&dir, "../escape").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn cards_filter_by_kind_and_text_and_count_before_the_limit() {
    let dir = library("mcp-cards");
    assert_eq!(ids(&cards_where(&dir, None, None, None)), ["p", "d", "e"]);
    assert_eq!(ids(&cards_where(&dir, Some(CardKind::Person), None, None)), ["p"]);
    let jane = cards_where(&dir, None, Some("JANE"), Some(1));
    assert_eq!((jane["total"].as_u64(), ids(&jane)), (Some(2), vec!["p"]));
    assert_eq!(ids(&cards_where(&dir, Some(CardKind::Event), Some("jane"), None)), ["e"]);
    assert_eq!(jane["cards"][0], json!({ "id": "p", "kind": "person", "title": "Jane Roe", "occurredAt": null, "clusterIds": ["g"] }));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn search_finds_extracted_text_and_the_cards_that_carry_it() {
    let dir = library("mcp-search");
    let found = search(&dir, "offshore", 20).unwrap();
    let hit = &found["hits"][0];
    assert_eq!(hit["name"], "aa.pdf");
    assert!(hit["snippet"].as_str().unwrap().contains("<mark>offshore</mark>"));
    assert_eq!(hit["cards"], json!([{ "boardId": "brd_acme", "cardId": "d", "title": "Ledger" }]));
    assert_eq!(search(&dir, "nowhere", 20).unwrap(), json!({ "hits": [] }));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn media_text_is_the_indexed_text_or_none() {
    let dir = library("mcp-media");
    assert_eq!(
      media_text(&dir, "aa.pdf").unwrap(),
      json!({ "name": "aa.pdf", "status": "indexed", "text": "quarterly ledger of offshore payments" })
    );
    assert_eq!(media_text(&dir, "bb.png").unwrap()["text"], Value::Null);
    assert!(media_text(&dir, "cc.pdf").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn reading_a_board_leaves_the_open_sessions_writes_free() {
    let dir = library("mcp-beside-session");
    let path = dir.join("boards/brd_acme.sqlite");
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE; UPDATE cards SET json = json WHERE id = 'p';").unwrap();
    assert_eq!(board_summary(&dir, "brd_acme").unwrap()["cards"], 3);
    writer.execute_batch("COMMIT;").unwrap();
    assert!(open_read_only(&path).unwrap().execute("DELETE FROM cards", []).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_token_is_32_base64url_characters_and_fresh_each_time() {
    let token = random_token().unwrap();
    assert_eq!(token.expose().len(), 32);
    assert!(token.expose().bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_ne!(token.expose(), random_token().unwrap().expose());
  }

  #[test]
  fn a_taken_port_is_an_error_not_another_port() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let dir = temp_dir_for("mcp-taken-port");
    let host = Arc::new(writes::Detached::new(&dir));
    assert!(start(dir.clone(), host, Allowed::default(), port, "t".into()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
