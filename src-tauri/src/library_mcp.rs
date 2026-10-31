//! The library MCP: a loopback server whose tools read the library straight from its
//! files, never through the webview, and write nothing. Also the bring-up the dev
//! harness (`mcp`) shares.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::{self, JsonSchema};
use rmcp::{tool, tool_router, ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wslib_mcp::http::{self, ClientPolicy, HostPolicy, HttpConfig};
use wslib_mcp::result::{internal_error, ok_json, tool_error};
use wslib_mcp::rmcp;
use wslib_mcp::router::mark_read_only;
use wslib_mcp::server::{ServerIdentity, ToolServer};
use wslib_mcp::CancellationToken;

use crate::board_store::board_db::peek_board;
use crate::board_store::board_index::{summaries, BoardSummary};
use crate::board_store::open_read_only;
use crate::library_index::{run_search, DocHit};
use crate::schema::{Board, Card, CardKind};

pub(crate) mod lifecycle;

pub(crate) const PORT: u16 = 8793;

pub(crate) fn start(library: PathBuf, port: u16, token: String) -> Result<CancellationToken, String> {
  let tools = LibraryTools { library };
  let router = Arc::new(LibraryTools::router());
  let identity = LibraryTools::identity();
  serve_loopback(port, token, move || ToolServer::new(tools.clone(), router.clone(), identity.clone()))
}

/// Binds now, so a taken port is an error here rather than a server on another port.
pub(crate) fn serve_loopback<S: ServerHandler + Send + 'static>(
  port: u16,
  token: String,
  factory: impl Fn() -> S + Send + Sync + 'static,
) -> Result<CancellationToken, String> {
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
  tauri::async_runtime::spawn(async move {
    if let Err(e) = http::serve(listener, factory, config, stop).await {
      log::warn!("[mcp] server on {port} stopped: {e}");
    }
  });
  Ok(cancel)
}

pub(crate) fn random_token() -> Result<String, String> {
  let mut bytes = [0u8; 24];
  getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
  Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Clone)]
struct LibraryTools {
  library: PathBuf,
}

impl LibraryTools {
  fn router() -> ToolRouter<Self> {
    let mut router = Self::read_router();
    mark_read_only(&mut router);
    router
  }

  fn identity() -> ServerIdentity {
    ServerIdentity::new("conspiracy-library", env!("CARGO_PKG_VERSION"))
      .with_title("Conspiracy library")
      .with_instructions(
        "Read-only access to the Conspiracy library: its boards, their cards, connections and \
         clusters, and the text extracted from imported files. Nothing here changes the library.",
      )
  }

  async fn answer<T: Serialize + Send + 'static>(
    &self,
    read: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
  ) -> Result<CallToolResult, ErrorData> {
    let library = self.library.clone();
    match tauri::async_runtime::spawn_blocking(move || read(&library)).await {
      Ok(Ok(value)) => ok_json(value),
      Ok(Err(e)) => Ok(tool_error(e)),
      Err(e) => Err(internal_error(e.to_string())),
    }
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
      "SELECT d.status, f.body FROM documents d LEFT JOIN doc_fts f ON f.name = d.name WHERE d.name = ?1",
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

  fn library(name: &str) -> PathBuf {
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
  fn every_library_tool_is_read_only() {
    let tools: Vec<_> = LibraryTools::router()
      .list_all()
      .into_iter()
      .map(|t| (t.name.to_string(), t.annotations.and_then(|a| a.read_only_hint)))
      .collect();
    let expected = [
      "board_summary",
      "get_card",
      "list_boards",
      "list_cards",
      "list_clusters",
      "list_connections",
      "media_text",
      "search_library",
    ]
    .map(|name| (name.to_string(), Some(true)));
    assert_eq!(tools, expected);
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
  fn a_token_is_48_hex_digits_and_fresh_each_time() {
    let token = random_token().unwrap();
    assert_eq!(token.len(), 48);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(token, random_token().unwrap());
  }

  #[test]
  fn a_taken_port_is_an_error_not_another_port() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    assert!(start(PathBuf::new(), port, "t".into()).is_err());
  }
}
