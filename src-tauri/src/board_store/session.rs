//! The open board's document. Rust holds it, and each command edits it in one
//! transaction on the rows it touches, then broadcasts `doc:changed` with the new rows.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OpenFlags, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, State};

use super::board_db::{
  board_db, change_media_refs, delete_rows, from_value, reassemble_board, to_json, upsert_meta, upsert_rows,
};
use super::board_index::upsert_summary;
use crate::library_index::LibraryDb;
use crate::schema::{parse_card, Board, BoardMeta, Card, Cluster, Connection, Vec2, Viewport, BOARD_VERSION};

const DOC_CHANGED: &str = "doc:changed";

#[derive(Default)]
pub struct OpenBoard(Mutex<Option<Session>>);

impl OpenBoard {
  fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Session>>, String> {
    self.0.lock().map_err(|_| "The open board is unavailable.".to_string())
  }

  pub(super) fn close(&self, board_id: &str) -> Result<(), String> {
    let mut open = self.lock()?;
    if open.as_ref().is_some_and(|s| s.board_id == board_id) {
      *open = None;
    }
    Ok(())
  }
}

/// One edit to the open board. `meta` is present when the edit touched content, which
/// is what restamps `updatedAt`; a viewport-only edit carries `viewport` alone.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocChanged {
  pub board_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub meta: Option<BoardMeta>,
  #[serde(skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub viewport: Option<Viewport>,
  pub cards: Vec<Card>,
  pub connections: Vec<Connection>,
  pub clusters: Vec<Cluster>,
  pub removed_cards: Vec<String>,
  pub removed_connections: Vec<String>,
  pub removed_clusters: Vec<String>,
}

impl DocChanged {
  fn touches_content(&self) -> bool {
    self.meta.is_some()
      || !(self.cards.is_empty()
        && self.connections.is_empty()
        && self.clusters.is_empty()
        && self.removed_cards.is_empty()
        && self.removed_connections.is_empty()
        && self.removed_clusters.is_empty())
  }
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MetaPatch {
  title: Option<String>,
  country_code: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CardMove {
  id: String,
  position: Vec2,
}

trait Row: Clone + PartialEq + Serialize {
  fn id(&self) -> &str;
}

impl Row for Card {
  fn id(&self) -> &str {
    &self.id
  }
}

impl Row for Connection {
  fn id(&self) -> &str {
    &self.id
  }
}

impl Row for Cluster {
  fn id(&self) -> &str {
    &self.id
  }
}

pub struct Session {
  board_id: String,
  conn: rusqlite::Connection,
  board: Board,
}

type Outcome = Result<Option<DocChanged>, String>;

impl Session {
  /// Reads only: the database must already exist, and opening it writes nothing.
  fn open(path: &Path, board_id: String) -> Result<Self, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = rusqlite::Connection::open_with_flags(path, flags)
      .map_err(|e| format!("Could not open the board database: {e}"))?;
    // FULL rather than NORMAL plus a checkpoint: a commit is durable without folding
    // the WAL back after every edit.
    conn
      .execute_batch("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;")
      .map_err(|e| format!("Could not prepare the board database: {e}"))?;
    let board = reassemble_board(&conn)?;
    Ok(Self { board_id, conn, board })
  }

  fn card(&self, id: &str) -> Option<&Card> {
    self.board.cards.iter().find(|c| c.id == id)
  }

  fn has_card(&self, id: &str) -> bool {
    self.card(id).is_some()
  }

  fn update_card(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    let Some(card) = self.card(id) else { return Ok(None) };
    let next = patched(card, patch, parse_card)?;
    self.commit(DocChanged { cards: changed(card, next), ..Default::default() })
  }

  fn move_cards(&mut self, moves: &[CardMove]) -> Outcome {
    let cards = moves
      .iter()
      .filter_map(|m| self.card(&m.id).filter(|c| c.position != m.position).map(|c| Card { position: m.position, ..c.clone() }))
      .collect();
    self.commit(DocChanged { cards, ..Default::default() })
  }

  /// Cards and the strings among them, in one edit. A string repeating an existing
  /// source→target pair is dropped, as `addConnection` drops it.
  fn add_cards(&mut self, cards: Vec<Card>, connections: Vec<Connection>) -> Outcome {
    let mut card_ids: HashSet<&str> = self.board.cards.iter().map(|c| c.id.as_str()).collect();
    for card in &cards {
      if !card_ids.insert(&card.id) {
        return Err(format!("The board already has a card {:?}.", card.id));
      }
    }
    let mut link_ids: HashSet<&str> = self.board.connections.iter().map(|c| c.id.as_str()).collect();
    let mut pairs: HashSet<(&str, &str)> =
      self.board.connections.iter().map(|c| (c.source.as_str(), c.target.as_str())).collect();
    let mut fresh = Vec::new();
    for link in &connections {
      if link.source == link.target || !card_ids.contains(link.source.as_str()) || !card_ids.contains(link.target.as_str()) {
        return Err(format!("Connection {:?} must join two cards on the board.", link.id));
      }
      if !link_ids.insert(&link.id) {
        return Err(format!("The board already has a connection {:?}.", link.id));
      }
      if pairs.insert((&link.source, &link.target)) {
        fresh.push(link.clone());
      }
    }
    self.commit(DocChanged { cards, connections: fresh, ..Default::default() })
  }

  /// Every string tied to a deleted card goes with it.
  fn delete_cards(&mut self, ids: &[String]) -> Outcome {
    let removed_cards: Vec<String> = ids.iter().filter(|id| self.has_card(id)).cloned().collect();
    let removed_connections = self
      .board
      .connections
      .iter()
      .filter(|c| removed_cards.iter().any(|id| *id == c.source || *id == c.target))
      .map(|c| c.id.clone())
      .collect();
    self.commit(DocChanged { removed_cards, removed_connections, ..Default::default() })
  }

  fn update_connection(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    let Some(link) = self.board.connections.iter().find(|c| c.id == id) else { return Ok(None) };
    let next: Connection = patched(link, patch, from_value)?;
    if next.source == next.target || !self.has_card(&next.source) || !self.has_card(&next.target) {
      return Err(format!("Connection {id:?} must join two cards on the board."));
    }
    self.commit(DocChanged { connections: changed(link, next), ..Default::default() })
  }

  fn delete_connections(&mut self, ids: &[String]) -> Outcome {
    let removed_connections =
      ids.iter().filter(|id| self.board.connections.iter().any(|c| c.id == **id)).cloned().collect();
    self.commit(DocChanged { removed_connections, ..Default::default() })
  }

  fn add_cluster(&mut self, cluster: Cluster) -> Outcome {
    if self.board.clusters.iter().any(|c| c.id == cluster.id) {
      return Err(format!("The board already has a cluster {:?}.", cluster.id));
    }
    self.commit(DocChanged { clusters: vec![cluster], ..Default::default() })
  }

  fn update_cluster(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    let Some(cluster) = self.board.clusters.iter().find(|c| c.id == id) else { return Ok(None) };
    let next = patched(cluster, patch, from_value)?;
    self.commit(DocChanged { clusters: changed(cluster, next), ..Default::default() })
  }

  /// Member cards stay, losing only this membership.
  fn delete_cluster(&mut self, id: &str) -> Outcome {
    if !self.board.clusters.iter().any(|c| c.id == id) {
      return Ok(None);
    }
    let cards = self
      .board
      .cards
      .iter()
      .filter(|c| c.cluster_ids.iter().any(|x| x == id))
      .map(|c| Card { cluster_ids: c.cluster_ids.iter().filter(|x| *x != id).cloned().collect(), ..c.clone() })
      .collect();
    self.commit(DocChanged { cards, removed_clusters: vec![id.to_string()], ..Default::default() })
  }

  fn set_meta(&mut self, patch: MetaPatch) -> Outcome {
    let current = &self.board.meta;
    let meta = BoardMeta {
      title: patch.title.unwrap_or_else(|| current.title.clone()),
      country_code: patch.country_code.or_else(|| current.country_code.clone()),
      updated_at: current.updated_at.clone(),
    };
    let meta = (meta != *current).then_some(meta);
    self.commit(DocChanged { meta, ..Default::default() })
  }

  fn set_viewport(&mut self, viewport: Viewport) -> Outcome {
    let viewport = (self.board.viewport != Some(viewport)).then_some(viewport);
    self.commit(DocChanged { viewport, ..Default::default() })
  }

  /// Writes the change in one transaction, then applies it to the held board, so a
  /// failed write leaves both as they were. An empty change writes and emits nothing.
  fn commit(&mut self, mut change: DocChanged) -> Outcome {
    let content = change.touches_content();
    if !content && change.viewport.is_none() {
      return Ok(None);
    }
    if content {
      let mut meta = change.meta.take().unwrap_or_else(|| self.board.meta.clone());
      meta.updated_at = now_utc();
      change.meta = Some(meta);
    }
    let mut next = self.board.clone();
    apply(&mut next.cards, &change.cards, &change.removed_cards);
    apply(&mut next.connections, &change.connections, &change.removed_connections);
    apply(&mut next.clusters, &change.clusters, &change.removed_clusters);
    if let Some(meta) = &change.meta {
      next.meta = meta.clone();
    }
    next.viewport = change.viewport.or(next.viewport);

    let tx = self
      .conn
      .transaction_with_behavior(TransactionBehavior::Immediate)
      .map_err(|e| format!("Could not begin the edit: {e}"))?;
    write(&tx, "cards", "card_order", &self.board.cards, &next.cards, &change.cards, &change.removed_cards)?;
    write(
      &tx,
      "connections",
      "connection_order",
      &self.board.connections,
      &next.connections,
      &change.connections,
      &change.removed_connections,
    )?;
    write(&tx, "clusters", "cluster_order", &self.board.clusters, &next.clusters, &change.clusters, &change.removed_clusters)?;
    let (was, now) = (media_refs(&self.board), media_refs(&next));
    change_media_refs(&tx, now.difference(&was).copied(), was.difference(&now).copied())?;
    if let Some(meta) = &change.meta {
      upsert_meta(&tx, "version", &BOARD_VERSION.to_string())?;
      upsert_meta(&tx, "meta", &to_json(meta)?)?;
    }
    if let Some(viewport) = &change.viewport {
      upsert_meta(&tx, "viewport", &to_json(viewport)?)?;
    }
    tx.commit().map_err(|e| format!("Could not save the edit: {e}"))?;

    self.board = next;
    change.board_id = self.board_id.clone();
    Ok(Some(change))
  }
}

fn changed<T: PartialEq>(current: &T, next: T) -> Vec<T> {
  if *current == next {
    Vec::new()
  } else {
    vec![next]
  }
}

/// The row with `patch`'s fields laid over it, validated as a whole.
fn patched<T: Row>(row: &T, patch: Map<String, Value>, parse: impl Fn(Value) -> Result<T, String>) -> Result<T, String> {
  let mut value = serde_json::to_value(row).map_err(|e| format!("Could not encode the board: {e}"))?;
  if let Value::Object(fields) = &mut value {
    fields.extend(patch);
  }
  let next = parse(value)?;
  if next.id() != row.id() {
    return Err(format!("{:?} can't change its id.", row.id()));
  }
  Ok(next)
}

fn apply<T: Row>(rows: &mut Vec<T>, upserts: &[T], removed: &[String]) {
  rows.retain(|r| !removed.iter().any(|id| id == r.id()));
  for upsert in upserts {
    match rows.iter_mut().find(|r| r.id() == upsert.id()) {
      Some(row) => *row = upsert.clone(),
      None => rows.push(upsert.clone()),
    }
  }
}

/// The order row is rewritten only when the set of rows changed.
fn write<T: Row>(
  tx: &Transaction,
  table: &str,
  order_key: &str,
  before: &[T],
  after: &[T],
  upserts: &[T],
  removed: &[String],
) -> Result<(), String> {
  let rows = upserts.iter().map(|r| Ok((r.id(), to_json(r)?))).collect::<Result<Vec<_>, String>>()?;
  upsert_rows(tx, table, rows.iter().map(|(id, json)| (*id, json.as_str())))?;
  delete_rows(tx, table, removed.iter().map(String::as_str))?;
  let ids = |rows: &[T]| rows.iter().map(|r| r.id().to_string()).collect::<Vec<_>>();
  let order = ids(after);
  if ids(before) != order {
    upsert_meta(tx, order_key, &to_json(&order)?)?;
  }
  Ok(())
}

fn media_refs(board: &Board) -> HashSet<&str> {
  board.cards.iter().flat_map(Card::media_files).collect()
}

fn now_utc() -> String {
  let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
  crate::mail::iso_utc_millis(since.as_secs() as i64, since.subsec_millis())
}

/// Runs `edit` on the open board if it is `board_id`, then lists a content change in
/// the board list and broadcasts it. The lock is held throughout, so events go out in
/// commit order, and a quit waits while any edit is queued or running.
fn edit(
  app: &AppHandle,
  open: &OpenBoard,
  library: &LibraryDb,
  board_id: &str,
  edit: impl FnOnce(&mut Session) -> Outcome,
) -> Result<(), String> {
  let _held = crate::quit::hold(app);
  let mut guard = open.lock()?;
  let session = guard.as_mut().filter(|s| s.board_id == board_id).ok_or("That board isn't open.")?;
  let Some(change) = edit(session)? else { return Ok(()) };
  if let Some(meta) = &change.meta {
    upsert_summary(&*library.lock_db()?, board_id, &meta.title, &meta.updated_at)?;
  }
  let _ = app.emit(DOC_CHANGED, &change);
  Ok(())
}

#[tauri::command(async)]
pub fn open_board_session(app: AppHandle, open: State<OpenBoard>, board_id: String) -> Result<Board, String> {
  let path = board_db(&app, &board_id)?.ok_or("That board has no file.")?;
  let session = Session::open(&path, board_id)?;
  let board = session.board.clone();
  *open.lock()? = Some(session);
  Ok(board)
}

#[tauri::command(async)]
pub fn close_board_session(open: State<OpenBoard>, board_id: String) -> Result<(), String> {
  open.close(&board_id)
}

#[tauri::command(async)]
pub fn update_card(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  id: String,
  patch: Map<String, Value>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.update_card(&id, patch))
}

#[tauri::command(async)]
pub fn move_cards(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  moves: Vec<CardMove>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.move_cards(&moves))
}

#[tauri::command(async)]
pub fn add_cards(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  cards: Vec<Card>,
  connections: Vec<Connection>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.add_cards(cards, connections))
}

#[tauri::command(async)]
pub fn delete_cards(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  ids: Vec<String>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.delete_cards(&ids))
}

#[tauri::command(async)]
pub fn add_connections(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  connections: Vec<Connection>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.add_cards(Vec::new(), connections))
}

#[tauri::command(async)]
pub fn update_connection(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  id: String,
  patch: Map<String, Value>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.update_connection(&id, patch))
}

#[tauri::command(async)]
pub fn delete_connections(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  ids: Vec<String>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.delete_connections(&ids))
}

#[tauri::command(async)]
pub fn add_cluster(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  cluster: Cluster,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.add_cluster(cluster))
}

#[tauri::command(async)]
pub fn update_cluster(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  id: String,
  patch: Map<String, Value>,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.update_cluster(&id, patch))
}

#[tauri::command(async)]
pub fn delete_cluster(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  id: String,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.delete_cluster(&id))
}

#[tauri::command(async)]
pub fn set_meta(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  patch: MetaPatch,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.set_meta(patch))
}

#[tauri::command(async)]
pub fn set_viewport(
  app: AppHandle,
  open: State<OpenBoard>,
  library: State<LibraryDb>,
  board_id: String,
  viewport: Viewport,
) -> Result<(), String> {
  edit(&app, &open, &library, &board_id, |s| s.set_viewport(viewport))
}

#[cfg(test)]
mod tests;
