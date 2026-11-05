//! The write tools, behind the Add and Edit switches. Each goes through the board
//! session's commands (`session::writes`), and none deletes anything.

use std::path::Path;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ToolAnnotations};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{tool, tool_router, ErrorData};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use wslib_mcp::rmcp;
use wslib_secret::{Encoding, Secret};

use super::LibraryTools;
use crate::board_store::board_db::create_listed_board;
use crate::board_store::media::{media_store, ocr_bytes};
use crate::board_store::session::writes::{edit_board, only, CARD_FIELDS};
use crate::board_store::session::{emit_doc_changed, now_utc, OpenBoard, Outcome, Session};
use crate::board_store::boards_dir;
use crate::file_types::{file_name, kind_of, FileKind};
use crate::import::media_draft;
use crate::library_index::LibraryDb;
use crate::mail;
use crate::schema::{parse_card, Board, BoardMeta, Card, Cluster, Connection, ConnectionKind, Grade, Vec2, BOARD_VERSION};

/// Big enough for a long PDF or a year of mail, small enough to hold in memory.
const IMPORT_LIMIT: u64 = 256 * 1024 * 1024;

/// What a write needs from the app: its board session, the board list and the media library.
pub(crate) trait Host: Send + Sync {
  fn edit(&self, board_id: &str, edit: Box<dyn FnOnce(&mut Session) -> Outcome + '_>) -> Outcome;
  fn create_board(&self, id: &str, board: &Board) -> Result<(), String>;
  fn keep(&self, bytes: &[u8], ext: &str) -> Option<String>;
  fn ocr(&self, bytes: &[u8]) -> String;
}

impl Host for AppHandle {
  fn edit(&self, board_id: &str, edit: Box<dyn FnOnce(&mut Session) -> Outcome + '_>) -> Outcome {
    let _held = crate::quit::hold(self);
    let (open, library) = (self.state::<OpenBoard>(), self.state::<LibraryDb>());
    edit_board(&open, &library, &boards_dir(self)?, board_id, edit, |change| emit_doc_changed(self, change))
  }

  fn create_board(&self, id: &str, board: &Board) -> Result<(), String> {
    let _held = crate::quit::hold(self);
    create_listed_board(&boards_dir(self)?, &self.state::<LibraryDb>(), id, board)
  }

  fn keep(&self, bytes: &[u8], ext: &str) -> Option<String> {
    media_store(self)(bytes, ext)
  }

  fn ocr(&self, bytes: &[u8]) -> String {
    ocr_bytes(bytes)
  }
}

/// The library at `dir` with no app around it, for tests.
#[cfg(test)]
pub(crate) struct Detached {
  pub(crate) dir: std::path::PathBuf,
  pub(crate) open: OpenBoard,
  pub(crate) db: LibraryDb,
  pub(crate) events: std::sync::Mutex<Vec<crate::board_store::session::DocChanged>>,
}

#[cfg(test)]
impl Detached {
  pub(crate) fn new(dir: &Path) -> Self {
    let db = crate::library_index::open_at(dir).unwrap();
    Self { dir: dir.to_path_buf(), open: OpenBoard::default(), db, events: Default::default() }
  }
}

#[cfg(test)]
impl Host for Detached {
  fn edit(&self, board_id: &str, edit: Box<dyn FnOnce(&mut Session) -> Outcome + '_>) -> Outcome {
    let emit = |change: &crate::board_store::session::DocChanged| self.events.lock().unwrap().push(change.clone());
    edit_board(&self.open, &self.db, &self.dir.join("boards"), board_id, edit, emit)
  }

  fn create_board(&self, id: &str, board: &Board) -> Result<(), String> {
    create_listed_board(&self.dir.join("boards"), &self.db, id, board)
  }

  fn keep(&self, bytes: &[u8], ext: &str) -> Option<String> {
    crate::board_store::media::keep_media_in(&self.dir.join("media"), bytes, ext).ok()
  }

  fn ocr(&self, _bytes: &[u8]) -> String {
    String::new()
  }
}

/// Every write tool is stamped alike: it changes the library, and never destructively.
pub(super) fn not_destructive(mut router: ToolRouter<LibraryTools>) -> ToolRouter<LibraryTools> {
  for route in router.map.values_mut() {
    route.attr.annotations = Some(ToolAnnotations::new().read_only(false).destructive(false));
  }
  router
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
struct Point {
  x: f64,
  y: f64,
}

impl From<Point> for Vec2 {
  fn from(Point { x, y }: Point) -> Self {
    Vec2 { x, y }
  }
}

#[derive(Deserialize, JsonSchema)]
struct ImportArgs {
  board_id: String,
  /// An absolute path to a file on this Mac: email (.eml, .emlx, .mbox), a picture or a document.
  path: String,
  /// Where the card goes, or where a batch of them starts. Left out, they go clear of the board's cards.
  position: Option<Point>,
  /// The clusters the new cards join.
  cluster_ids: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
struct CreateCardArgs {
  board_id: String,
  /// The card's fields: title (required), notes, kind, occurredAt (a UTC ISO-8601 instant),
  /// occurredAtPrecision (day or minute), grade, clusterIds, and the payload for its kind
  /// (email, message, call, person, organisation, document or event).
  card: Map<String, Value>,
  /// Left out, the card goes clear of the board's cards.
  position: Option<Point>,
}

#[derive(Deserialize, JsonSchema)]
struct CreateConnectionArgs {
  board_id: String,
  source: String,
  target: String,
  label: Option<String>,
  /// red-string (the default) or plain.
  #[schemars(with = "Option<String>")]
  kind: Option<ConnectionKind>,
  /// adjudicated, admitted, confirmed, corroborated, asserted, inference, unresolved or refuted.
  #[schemars(with = "Option<String>")]
  grade: Option<Grade>,
}

#[derive(Deserialize, JsonSchema)]
struct CreateClusterArgs {
  board_id: String,
  label: String,
  /// A CSS colour such as #e23b3b; left out, the next in the palette.
  color: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct TitleArgs {
  title: String,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateArgs {
  board_id: String,
  id: String,
  /// The fields to change, with null to clear one.
  patch: Map<String, Value>,
}

#[derive(Deserialize, JsonSchema)]
struct CardPlace {
  card_id: String,
  x: f64,
  y: f64,
}

#[derive(Deserialize, JsonSchema)]
struct MoveArgs {
  board_id: String,
  moves: Vec<CardPlace>,
}

#[derive(Deserialize, JsonSchema)]
struct RenameArgs {
  board_id: String,
  title: String,
}

#[tool_router(router = add_router, vis = "pub(super)")]
impl LibraryTools {
  #[tool(description = "Import a file from disk onto a board: email (.eml, .emlx, .mbox) becomes email cards, a \
                        picture an evidence card, a document a document card. The file is copied into the \
                        library. A message already on the board is skipped.")]
  async fn import_file(&self, Parameters(args): Parameters<ImportArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| import_file(host, args)).await
  }

  #[tool(description = "Add a card to a board. It holds no files; import_file brings a file in.")]
  async fn create_card(&self, Parameters(args): Parameters<CreateCardArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| create_card(host, args)).await
  }

  #[tool(description = "Add a connection, a string from one card to another on the same board.")]
  async fn create_connection(&self, Parameters(args): Parameters<CreateConnectionArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| create_connection(host, args)).await
  }

  #[tool(description = "Add a cluster to a board. Cards join it through their clusterIds.")]
  async fn create_cluster(&self, Parameters(args): Parameters<CreateClusterArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| create_cluster(host, args)).await
  }

  #[tool(description = "Make a new, empty board.")]
  async fn create_board(&self, Parameters(args): Parameters<TitleArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| create_board(host, &args.title)).await
  }
}

#[tool_router(router = edit_router, vis = "pub(super)")]
impl LibraryTools {
  #[tool(description = "Change a card's fields: title, notes, kind, occurredAt, occurredAtPrecision, grade, \
                        clusterIds, or its kind's payload (email, message, call, person, organisation, document, \
                        event). A payload is replaced whole, and the files it names must stay as they are. \
                        move_cards moves a card.")]
  async fn update_card(&self, Parameters(args): Parameters<UpdateArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| changed(host.edit(&args.board_id, Box::new(|s| s.edit_card(&args.id, args.patch))))).await
  }

  #[tool(description = "Move cards on a board, each to a new x and y.")]
  async fn move_cards(&self, Parameters(args): Parameters<MoveArgs>) -> Result<CallToolResult, ErrorData> {
    let moves = args.moves.into_iter().map(|m| (m.card_id, Vec2 { x: m.x, y: m.y })).collect();
    self.write(move |host| changed(host.edit(&args.board_id, Box::new(|s| s.move_existing(moves))))).await
  }

  #[tool(description = "Change a connection's source, target, label, kind or grade.")]
  async fn update_connection(&self, Parameters(args): Parameters<UpdateArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| changed(host.edit(&args.board_id, Box::new(|s| s.edit_connection(&args.id, args.patch))))).await
  }

  #[tool(description = "Change a cluster's label, color or visibility.")]
  async fn update_cluster(&self, Parameters(args): Parameters<UpdateArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| changed(host.edit(&args.board_id, Box::new(|s| s.edit_cluster(&args.id, args.patch))))).await
  }

  #[tool(description = "Change a board's title.")]
  async fn rename_board(&self, Parameters(args): Parameters<RenameArgs>) -> Result<CallToolResult, ErrorData> {
    self.write(move |host| changed(host.edit(&args.board_id, Box::new(|s| s.rename(&args.title))))).await
  }
}

fn changed(outcome: Outcome) -> Result<Value, String> {
  Ok(json!({ "changed": outcome?.is_some() }))
}

fn new_id(prefix: &str) -> Result<String, String> {
  let random = Secret::random::<5>(Encoding::Base32).map_err(|e| e.to_string())?;
  Ok(format!("{prefix}_{}", random.expose().to_ascii_lowercase()))
}

/// A card of `fields` with a fresh id, waiting for `Session::place`.
fn new_card(mut fields: Map<String, Value>) -> Result<Card, String> {
  fields.insert("id".into(), json!(new_id("card")?));
  fields.entry("clusterIds").or_insert(json!([]));
  fields.insert("position".into(), json!({ "x": 0, "y": 0 }));
  parse_card(Value::Object(fields))
}

fn brief(card: &Card) -> Value {
  json!({ "id": card.id, "kind": card.kind, "title": card.title })
}

fn read_import(path: &str) -> Result<(String, Vec<u8>), String> {
  let path = Path::new(path);
  if !path.is_absolute() {
    return Err(format!("{} isn't an absolute path.", path.display()));
  }
  let meta = std::fs::metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
  if !meta.is_file() {
    return Err(format!("{} isn't a file.", path.display()));
  }
  if meta.len() > IMPORT_LIMIT {
    return Err(format!("{} is over the {} MB an import takes.", path.display(), IMPORT_LIMIT >> 20));
  }
  let bytes = std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
  Ok((file_name(path), bytes))
}

/// The cards a file makes, its media already kept, and any messages that would not parse.
fn drafts(host: &dyn Host, name: &str, bytes: &[u8]) -> Result<(Vec<Value>, Vec<String>), String> {
  fn encode(draft: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(draft).map_err(|e| e.to_string())
  }
  let mut keep = |bytes: &[u8], ext: &str| host.keep(bytes, ext);
  match kind_of(name) {
    Some(FileKind::Email) => {
      let parsed = mail::parse_file(name, bytes, &mut keep, &mut |_, _| {});
      Ok((parsed.drafts.into_iter().map(encode).collect::<Result<_, _>>()?, parsed.errors))
    }
    Some(FileKind::Image | FileKind::Document) => {
      let draft = media_draft(name, bytes, &mut keep, |bytes| host.ocr(bytes)).ok_or("Could not keep the file.")?;
      Ok((vec![encode(draft)?], Vec::new()))
    }
    _ => Err(format!("{name} isn't email, a picture or a document.")),
  }
}

fn import_file(host: &dyn Host, args: ImportArgs) -> Result<Value, String> {
  let (name, bytes) = read_import(&args.path)?;
  let (drafts, errors) = drafts(host, &name, &bytes)?;
  if drafts.is_empty() {
    return Err(errors.join("\n"));
  }
  let clusters = json!(args.cluster_ids.unwrap_or_default());
  let mut cards = drafts
    .into_iter()
    .map(|draft| {
      let mut fields = draft.as_object().cloned().unwrap_or_default();
      fields.insert("clusterIds".into(), clusters.clone());
      new_card(fields)
    })
    .collect::<Result<Vec<_>, _>>()?;
  let total = cards.len();
  let mut added = Vec::new();
  host.edit(
    &args.board_id,
    Box::new(|session| {
      let mut seen: std::collections::HashSet<String> =
        session.cards().iter().filter_map(|c| c.email.as_ref()?.message_id.clone()).collect();
      cards.retain(|c| c.email.as_ref().and_then(|e| e.message_id.clone()).is_none_or(|id| seen.insert(id)));
      session.place(&mut cards, args.position.map(Vec2::from));
      added = cards.iter().map(brief).collect();
      session.add(Vec::new(), cards, Vec::new())
    }),
  )?;
  Ok(json!({ "cards": added, "skipped": total - added.len(), "errors": errors }))
}

fn create_card(host: &dyn Host, args: CreateCardArgs) -> Result<Value, String> {
  only(&args.card, CARD_FIELDS, "card")?;
  let mut card = new_card(args.card)?;
  if card.media_files().next().is_some() {
    return Err("A new card can't name media files; import_file brings a file in.".into());
  }
  host.edit(
    &args.board_id,
    Box::new(|session| {
      session.place(std::slice::from_mut(&mut card), args.position.map(Vec2::from));
      session.add(Vec::new(), vec![card.clone()], Vec::new())
    }),
  )?;
  Ok(json!({ "card": card }))
}

fn create_connection(host: &dyn Host, args: CreateConnectionArgs) -> Result<Value, String> {
  let link = Connection {
    id: new_id("edge")?,
    source: args.source,
    target: args.target,
    label: args.label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()),
    kind: args.kind.unwrap_or_default(),
    grade: args.grade,
  };
  host.edit(&args.board_id, Box::new(|session| session.add(Vec::new(), Vec::new(), vec![link.clone()])))?;
  Ok(json!({ "connection": link }))
}

fn create_cluster(host: &dyn Host, args: CreateClusterArgs) -> Result<Value, String> {
  let id = new_id("cl")?;
  let mut made = None;
  host.edit(
    &args.board_id,
    Box::new(|session| {
      let color = args.color.unwrap_or_else(|| session.next_cluster_colour());
      let cluster = made.insert(Cluster { id, label: args.label, color, visible: true }).clone();
      session.add(vec![cluster], Vec::new(), Vec::new())
    }),
  )?;
  Ok(json!({ "cluster": made }))
}

fn create_board(host: &dyn Host, title: &str) -> Result<Value, String> {
  let title = title.trim();
  if title.is_empty() {
    return Err("A board needs a title.".into());
  }
  let id = new_id("brd")?;
  let meta = BoardMeta { title: title.to_string(), updated_at: now_utc(), country_code: None, unclustered_hidden: false };
  let board = Board { version: BOARD_VERSION, meta, clusters: vec![], cards: vec![], connections: vec![], viewport: None };
  host.create_board(&id, &board)?;
  Ok(json!({ "board": { "id": id, "title": title } }))
}

#[cfg(test)]
mod tests;
