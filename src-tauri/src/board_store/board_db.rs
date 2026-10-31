//! Per-board SQLite.
//!
//! One database per board (boards/<id>.sqlite). The webview hands `save_board` the
//! board split into rows — each card/connection/cluster as `{ id, json }`, plus the
//! complete ordered id lists and the envelope's small parts — and this side validates
//! each body against the schema, upserts it in canonical form and deletes any row whose
//! id is no longer present, all in one transaction. `load_board` reassembles the rows
//! and returns the validated, migrated board. The old `boards/<id>.json` is read once,
//! on first open, and migrated (see the seam in src/storage/tauriStorage.ts, which then
//! calls `retire_legacy_board`).
//!
//! A board's cards, connections and clusters are one `(id, json)` row each, so a
//! save writes only the rows that changed rather than rewriting the whole board, and
//! a crash can't tear the file (WAL + one transaction per save). Rust owns the board
//! and its cards: the schema is `crate::schema`, and the webview's types are generated
//! from it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use super::board_index::{listed_ids, remove_summary, upsert_summary};
use super::session::OpenBoard;
use super::{boards_dir, read_opt, remove_if_present, run_open};
use crate::library_index::LibraryDb;
use crate::schema::{self, parse_board, parse_board_json, parse_card, Board, BoardMeta, Viewport, BOARD_VERSION};

/// Whether an id is safe to reach the filesystem as a filename. Ids are generated
/// as `brd_<hex>` (`src/lib/ids.ts`), so this rejects nothing legitimate; it exists
/// because an id arrives from the webview, the imported `index.json` (an ordinary
/// file a user can hand-edit) or a bundle's `boards/<id>.json` entry name — without
/// it, an id of `../../../etc/something` would be honoured. `board_file`, the bundle
/// reader and the board list all go through it, so one rule covers every path an id
/// takes to disk.
pub(super) fn valid_board_id(id: &str) -> bool {
  !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn board_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !valid_board_id(id) {
    return Err(format!("Not a usable board id: {id:?}"));
  }
  Ok(boards_dir(app)?.join(format!("{id}.json")))
}

pub(super) fn board_db_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !valid_board_id(id) {
    return Err(format!("Not a usable board id: {id:?}"));
  }
  Ok(boards_dir(app)?.join(format!("{id}.sqlite")))
}

/// The `-wal`/`-shm` sidecar beside a board database. They live in `boards/`, which
/// the media sweep never scans, and are normally folded away after each save's
/// checkpoint; `delete_board` still removes them explicitly.
fn db_sidecar(path: &Path, suffix: &str) -> PathBuf {
  let mut s = path.as_os_str().to_os_string();
  s.push(suffix);
  PathBuf::from(s)
}

/// Open (creating if absent) a board database with the tables and pragmas it needs.
/// WAL so a reader never blocks the writer and a crash can't tear the file;
/// `synchronous=NORMAL` paired with a checkpoint after each save (see `save_board`)
/// for durability equal to the old atomic rename; `busy_timeout` so a second app
/// instance retries rather than failing.
fn open_board_db(path: &Path) -> Result<Connection, String> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
  }
  let conn = Connection::open(path).map_err(|e| format!("Could not open the board database: {e}"))?;
  conn
    .execute_batch(
      "PRAGMA journal_mode=WAL;
       PRAGMA synchronous=NORMAL;
       PRAGMA busy_timeout=5000;
       PRAGMA foreign_keys=OFF;",
    )
    .map_err(|e| format!("Could not prepare the board database: {e}"))?;
  init_board_schema(&conn)?;
  Ok(conn)
}

/// The tables, kept apart from the file-level pragmas so a test can build them on an
/// in-memory connection. `user_version` is this database file's schema version, a
/// hook for a later in-place migration, distinct from the board's own `version`
/// (which is a card-schema concern and lives in the `meta` table).
fn init_board_schema(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      "CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS cards       (id TEXT PRIMARY KEY, json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS clusters    (id TEXT PRIMARY KEY, json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS media_refs  (name TEXT PRIMARY KEY);
       PRAGMA user_version=1;",
    )
    .map_err(|e| format!("Could not prepare the board schema: {e}"))
}

/// One board carved into rows: the envelope's parts, then every card/connection/
/// cluster body with the complete ordered id lists. Bodies are only the rows to
/// upsert — the seam sends just the ones whose JSON changed since the last save. The
/// id lists are always complete, so deletes and order never depend on which bodies the
/// caller chose to send.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SaveBoardPayload {
  #[cfg_attr(test, ts(type = "4"))]
  version: u8,
  meta: BoardMeta,
  viewport: Option<Viewport>,
  cards: Vec<BoardBody>,
  card_ids: Vec<String>,
  connections: Vec<BoardBody>,
  connection_ids: Vec<String>,
  clusters: Vec<BoardBody>,
  cluster_ids: Vec<String>,
  media_refs: Vec<String>,
}

/// A single entity to upsert: its id and its JSON, which is validated and stored in
/// canonical form. A string so the webview can send only the bodies that changed.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BoardBody {
  id: String,
  json: String,
}

/// What `load_board` returns: the board (or None on first run), and whether it came
/// from a legacy `boards/<id>.json` that the seam should now migrate.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct LoadedBoard {
  board: Option<Board>,
  legacy: bool,
}

#[tauri::command(async)]
pub fn load_board(app: AppHandle, id: String) -> Result<LoadedBoard, String> {
  let db = board_db_file(&app, &id)?;
  if db.exists() {
    return Ok(LoadedBoard { board: Some(read_board_db(&db)?), legacy: false });
  }
  // No database yet: a legacy JSON board is offered for the seam to migrate; nothing
  // at all is first run.
  match read_opt(board_file(&app, &id)?)? {
    Some(json) => Ok(LoadedBoard { board: Some(parse_board_json(&json)?), legacy: true }),
    None => Ok(LoadedBoard { board: None, legacy: false }),
  }
}

/// The bundled seed board, for a library with nothing in it yet.
#[tauri::command(async)]
pub fn seed_board() -> Result<Board, String> {
  parse_board_json(include_str!("../../../data/board.json"))
}

/// The board's rows, then its summary in the board list: a board is never listed
/// before it can be opened. Two files, so two commits.
#[tauri::command(async)]
pub fn save_board(
  app: AppHandle,
  db: State<LibraryDb>,
  id: String,
  payload: SaveBoardPayload,
) -> Result<(), String> {
  let mut conn = open_board_db(&board_db_file(&app, &id)?)?;
  let tx = conn
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| format!("Could not begin the save: {e}"))?;
  write_board_tx(&tx, &payload)?;
  tx.commit().map_err(|e| format!("Could not save the board: {e}"))?;
  // Fold the WAL back into the main file and fsync, so a completed save is durable in
  // boards/<id>.sqlite before this returns and the sidecars are normally absent.
  let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
  upsert_summary(&*db.lock_db()?, &id, &payload.meta.title, &payload.meta.updated_at)
}

/// Remove the legacy `boards/<id>.json` once its `.sqlite` is written and verified to
/// reassemble. The seam calls this only after a successful migrating save, so the
/// JSON is never removed before a coherent database exists to replace it.
#[tauri::command(async)]
pub fn retire_legacy_board(app: AppHandle, id: String) -> Result<(), String> {
  let db = board_db_file(&app, &id)?;
  if !db.exists() {
    return Err("The board's database is missing.".into());
  }
  read_board_db(&db)?; // reassembles, or errors before anything is deleted
  remove_if_present(&board_file(&app, &id)?)
}

/// Validate the envelope and every provided body, upsert them, then delete any row
/// whose id the caller no longer lists — the whole board in one transaction.
fn write_board_tx(tx: &Transaction, p: &SaveBoardPayload) -> Result<(), String> {
  if p.version != BOARD_VERSION {
    return Err(format!("Not a board version this build writes: {}", p.version));
  }
  let cards = checked(&p.cards, parse_card, |c| &c.id)?;
  let connections = checked(&p.connections, from_value::<schema::Connection>, |c| &c.id)?;
  let clusters = checked(&p.clusters, from_value::<schema::Cluster>, |c| &c.id)?;
  upsert_meta(tx, "version", &p.version.to_string())?;
  upsert_meta(tx, "meta", &to_json(&p.meta)?)?;
  upsert_meta(tx, "card_order", &to_json(&p.card_ids)?)?;
  upsert_meta(tx, "connection_order", &to_json(&p.connection_ids)?)?;
  upsert_meta(tx, "cluster_order", &to_json(&p.cluster_ids)?)?;
  match &p.viewport {
    Some(v) => upsert_meta(tx, "viewport", &to_json(v)?)?,
    None => {
      tx.execute("DELETE FROM meta WHERE key='viewport'", [])
        .map_err(|e| format!("Could not clear the viewport: {e}"))?;
    }
  }
  write_table(tx, "cards", &cards, &p.card_ids)?;
  write_table(tx, "connections", &connections, &p.connection_ids)?;
  write_table(tx, "clusters", &clusters, &p.cluster_ids)?;
  write_media_refs(tx, &p.media_refs)
}

/// Each body validated, its id checked against the row's, and re-serialised in
/// canonical form, so a row on disk is always a valid entity.
fn checked<T: Serialize>(
  bodies: &[BoardBody],
  parse: impl Fn(Value) -> Result<T, String>,
  id: impl Fn(&T) -> &str,
) -> Result<Vec<BoardBody>, String> {
  bodies
    .iter()
    .map(|body| {
      let value = serde_json::from_str(&body.json).map_err(|e| format!("Not valid JSON for {}: {e}", body.id))?;
      let entity = parse(value)?;
      if id(&entity) != body.id {
        return Err(format!("A row's body has another id: {}", body.id));
      }
      Ok(BoardBody { id: body.id.clone(), json: to_json(&entity)? })
    })
    .collect()
}

pub(super) fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, String> {
  serde_json::from_value(value).map_err(|e| format!("Not a valid board row: {e}"))
}

/// The media names the board's cards link, which TypeScript derives from the cards
/// (`boardMediaRefs`) and the sweep keeps. The `media_refs` meta row marks them as
/// recorded: a board saved before they were has the table but not the row.
fn write_media_refs(tx: &Transaction, refs: &[String]) -> Result<(), String> {
  tx.execute("DELETE FROM media_refs", []).map_err(|e| format!("Could not record media refs: {e}"))?;
  {
    let mut stmt = tx
      .prepare("INSERT OR IGNORE INTO media_refs(name) VALUES(?1)")
      .map_err(|e| format!("Could not record media refs: {e}"))?;
    for name in refs {
      stmt.execute([name]).map_err(|e| format!("Could not record media refs: {e}"))?;
    }
  }
  upsert_meta(tx, "media_refs", "recorded")
}

/// Leaves the recorded marker alone: a board whose refs were never recorded stays
/// unknown to the sweep, however many names are added here.
pub(super) fn change_media_refs<'a>(
  tx: &Transaction,
  added: impl IntoIterator<Item = &'a str>,
  removed: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
  let failed = |e: rusqlite::Error| format!("Could not record media refs: {e}");
  let mut insert = tx.prepare("INSERT OR IGNORE INTO media_refs(name) VALUES(?1)").map_err(failed)?;
  for name in added {
    insert.execute([name]).map_err(failed)?;
  }
  let mut delete = tx.prepare("DELETE FROM media_refs WHERE name=?1").map_err(failed)?;
  for name in removed {
    delete.execute([name]).map_err(failed)?;
  }
  Ok(())
}

/// Record the refs of a board saved before refs were, read for it by the webview.
/// Only while they are still unrecorded: a save in the meantime wrote fresher ones.
#[tauri::command(async)]
pub fn record_media_refs(app: AppHandle, id: String, refs: Vec<String>) -> Result<(), String> {
  let path = board_db_file(&app, &id)?;
  if !path.exists() {
    return Err("The board's database is missing.".into());
  }
  record_if_unrecorded(&mut open_board_db(&path)?, &refs)
}

fn record_if_unrecorded(conn: &mut Connection, refs: &[String]) -> Result<(), String> {
  let tx = conn
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| format!("Could not begin recording media refs: {e}"))?;
  if recorded_refs(&tx).map_err(|e| format!("Could not read media refs: {e}"))?.is_none() {
    write_media_refs(&tx, refs)?;
  }
  tx.commit().map_err(|e| format!("Could not record media refs: {e}"))
}

/// The board's recorded media refs, or None if it has none recorded yet.
fn recorded_refs(conn: &Connection) -> rusqlite::Result<Option<Vec<String>>> {
  let recorded = conn
    .query_row("SELECT 1 FROM meta WHERE key='media_refs'", [], |_| Ok(()))
    .optional()?
    .is_some();
  if !recorded {
    return Ok(None);
  }
  let mut stmt = conn.prepare("SELECT name FROM media_refs")?;
  let names = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
  Ok(Some(names))
}

/// Every media name the boards on disk link, and the ids of any board whose refs are
/// unknown: unrecorded, unreadable, or a legacy JSON board not yet migrated. While any
/// are unknown the set is incomplete, and nothing may be swept on its say-so.
#[derive(Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LibraryRefs {
  pub(crate) names: HashSet<String>,
  pub(crate) unknown: Vec<String>,
}

/// A board in the list with no file on disk is unknown too: it may only be unreachable
/// for now.
pub(crate) fn library_media_refs(
  boards: &Path,
  listed: &[String],
  except: Option<&str>,
) -> Result<LibraryRefs, String> {
  let entries = std::fs::read_dir(boards).map_err(|e| format!("Could not read the boards directory: {e}"))?;
  let mut refs = LibraryRefs::default();
  for id in listed {
    let file = boards.join(id);
    let on_disk = file.with_extension("sqlite").exists() || file.with_extension("json").exists();
    if !on_disk && Some(id.as_str()) != except {
      refs.unknown.push(id.clone());
    }
  }
  for entry in entries {
    let path = entry.map_err(|e| format!("Could not read the boards directory: {e}"))?.path();
    let (Some(id), Some(ext)) = (path.file_stem().and_then(|s| s.to_str()), path.extension()) else {
      continue;
    };
    if !valid_board_id(id) || Some(id) == except {
      continue;
    }
    let known = if ext == "sqlite" {
      read_refs(&path)
    } else if ext == "json" && !path.with_extension("sqlite").exists() {
      None
    } else {
      continue;
    };
    match known {
      Some(names) => refs.names.extend(names),
      None => refs.unknown.push(id.to_string()),
    }
  }
  Ok(refs)
}

/// A board's recorded refs, opened without creating anything: a file gone since the
/// listing, or one that won't read, is simply unknown.
fn read_refs(path: &Path) -> Option<Vec<String>> {
  let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
  let conn = Connection::open_with_flags(path, flags).ok()?;
  conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
  recorded_refs(&conn).ok().flatten()
}

/// The media refs of every board but `except` (the open one, whose live refs the
/// caller already has), for the maintenance audit.
#[tauri::command(async)]
pub fn media_refs(app: AppHandle, db: State<LibraryDb>, except: Option<String>) -> Result<LibraryRefs, String> {
  let listed = listed_ids(&*db.lock_db()?)?;
  library_media_refs(&boards_dir(&app)?, &listed, except.as_deref())
}

pub(super) fn to_json(value: &impl Serialize) -> Result<String, String> {
  serde_json::to_string(value).map_err(|e| format!("Could not encode the board: {e}"))
}

pub(super) fn upsert_meta(tx: &Transaction, key: &str, value: &str) -> Result<(), String> {
  tx.execute(
    "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    rusqlite::params![key, value],
  )
  .map_err(|e| format!("Could not save board metadata: {e}"))?;
  Ok(())
}

/// `table` is always one of the three literals this module and `session` pass — never
/// caller input — so formatting it into the statement carries no injection surface; ids
/// and json are bound parameters.
fn write_table(tx: &Transaction, table: &str, bodies: &[BoardBody], ids: &[String]) -> Result<(), String> {
  upsert_rows(tx, table, bodies.iter().map(|b| (b.id.as_str(), b.json.as_str())))?;
  let keep: HashSet<&str> = ids.iter().map(String::as_str).collect();
  let present: Vec<String> = {
    let mut stmt = tx
      .prepare(&format!("SELECT id FROM {table}"))
      .map_err(|e| format!("Could not read board rows: {e}"))?;
    stmt
      .query_map([], |r| r.get::<_, String>(0))
      .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
      .map_err(|e| format!("Could not read board rows: {e}"))?
  };
  delete_rows(tx, table, present.iter().map(String::as_str).filter(|id| !keep.contains(id)))
}

pub(super) fn upsert_rows<'a>(
  tx: &Transaction,
  table: &str,
  rows: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
  let sql = format!("INSERT INTO {table}(id,json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json");
  let mut stmt = tx.prepare(&sql).map_err(|e| format!("Could not prepare a board write: {e}"))?;
  for (id, json) in rows {
    stmt.execute(rusqlite::params![id, json]).map_err(|e| format!("Could not write a board row: {e}"))?;
  }
  Ok(())
}

pub(super) fn delete_rows<'a>(tx: &Transaction, table: &str, ids: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
  let mut del = tx
    .prepare(&format!("DELETE FROM {table} WHERE id=?1"))
    .map_err(|e| format!("Could not prepare a board delete: {e}"))?;
  for id in ids {
    del.execute([id]).map_err(|e| format!("Could not delete a board row: {e}"))?;
  }
  Ok(())
}

fn read_board_db(path: &Path) -> Result<Board, String> {
  reassemble_board(&open_board_db(path)?)
}

/// The rows put back together and validated as a board, migrated from whatever version
/// they were saved at.
pub(super) fn reassemble_board(conn: &Connection) -> Result<Board, String> {
  let meta = read_meta(conn)?;
  let version: u8 = meta.get("version").and_then(|v| v.parse().ok()).unwrap_or(3);
  let mut board = json!({
    "version": version,
    "meta": fragment(meta.get("meta").map_or("{}", String::as_str))?,
    "clusters": ordered_bodies(conn, "clusters", meta.get("cluster_order"))?,
    "cards": ordered_bodies(conn, "cards", meta.get("card_order"))?,
    "connections": ordered_bodies(conn, "connections", meta.get("connection_order"))?,
  });
  if let Some(viewport) = meta.get("viewport") {
    board["viewport"] = fragment(viewport)?;
  }
  parse_board(board)
}

fn read_meta(conn: &Connection) -> Result<HashMap<String, String>, String> {
  let mut stmt = conn
    .prepare("SELECT key, value FROM meta")
    .map_err(|e| format!("Could not read board metadata: {e}"))?;
  stmt
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    .and_then(|rows| rows.collect::<rusqlite::Result<HashMap<_, _>>>())
    .map_err(|e| format!("Could not read board metadata: {e}"))
}

/// Every row of a table, in the order the id list gives. An id in the order list with
/// no row is skipped; a row missing from the list is still emitted (after the ordered
/// ones), so a reassembly is lossless even if the two ever disagree.
fn ordered_bodies(conn: &Connection, table: &str, order: Option<&String>) -> Result<Vec<Value>, String> {
  let mut bodies: HashMap<String, String> = {
    let mut stmt = conn
      .prepare(&format!("SELECT id, json FROM {table}"))
      .map_err(|e| format!("Could not read board rows: {e}"))?;
    stmt
      .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
      .and_then(|rows| rows.collect::<rusqlite::Result<HashMap<_, _>>>())
      .map_err(|e| format!("Could not read board rows: {e}"))?
  };
  let ids: Vec<String> = order.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
  let mut out = Vec::with_capacity(bodies.len());
  for id in &ids {
    if let Some(json) = bodies.remove(id) {
      out.push(fragment(&json)?);
    }
  }
  for json in bodies.values() {
    out.push(fragment(json)?);
  }
  Ok(out)
}

fn fragment(s: &str) -> Result<Value, String> {
  serde_json::from_str(s).map_err(|e| format!("A stored board fragment was not valid JSON: {e}"))
}

/// Where a board is kept, for telling the user.
///
/// The rest of `src/` is told nothing about where boards live — that is the
/// whole point of the storage seam — but the user is a different question. These
/// are their files, holding their evidence, on their disk. A tool that will not
/// say where it put them is not one to trust with them, and "somewhere in
/// Application Support" is not an answer you can back up.
#[tauri::command(async)]
pub fn board_location(app: AppHandle, id: String) -> Result<String, String> {
  Ok(board_db_file(&app, &id)?.to_string_lossy().into_owned())
}

/// Show a board's file in Finder, selected.
///
/// `open -R` rather than a plugin: it is one line of shell against a path this
/// module already built and validated, where tauri-plugin-opener would be a
/// dependency, a capability and a permission to reason about for the same thing.
/// The path is never taken from the caller — only the id is, and board_file
/// rejects an id that is not one.
#[tauri::command(async)]
pub fn reveal_board(app: AppHandle, id: String) -> Result<(), String> {
  let db = board_db_file(&app, &id)?;
  // The database if it exists, else a not-yet-migrated legacy JSON, else nothing:
  // before the first autosave there is nothing to show, and saying so beats Finder
  // opening on an empty selection and looking broken.
  let path = if db.exists() {
    db
  } else {
    let legacy = board_file(&app, &id)?;
    if legacy.exists() {
      legacy
    } else {
      return Err("This board hasn't been saved to disk yet.".into());
    }
  };
  // `status()`, not `spawn()`: `open` returns the moment Finder has the request,
  // so waiting costs nothing and reaps the child rather than leaving a zombie
  // per click. Its own exit tells us whether Finder took it.
  run_open(
    &[std::ffi::OsStr::new("-R"), path.as_os_str()],
    "Could not show the board in Finder",
    "Finder wouldn't open the board's folder.",
  )
}

/// Deleting something already gone is a success — the caller wanted it absent. Takes
/// the database and its `-wal`/`-shm` sidecars, plus any legacy `boards/<id>.json`
/// left from before this board was migrated.
///
/// The files first, then the board list: a listed board whose file is gone would open
/// as null, where an unlisted file is merely invisible.
#[tauri::command(async)]
pub fn delete_board(app: AppHandle, library: State<LibraryDb>, open: State<OpenBoard>, id: String) -> Result<(), String> {
  open.close(&id)?;
  let db = board_db_file(&app, &id)?;
  remove_if_present(&db)?;
  remove_if_present(&db_sidecar(&db, "-wal"))?;
  remove_if_present(&db_sidecar(&db, "-shm"))?;
  remove_if_present(&board_file(&app, &id)?)?;
  remove_summary(&*library.lock_db()?, &id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::temp_dir_for;

  fn body(id: &str, json: Value) -> BoardBody {
    BoardBody { id: id.to_string(), json: json.to_string() }
  }

  fn card(id: &str, title: &str) -> BoardBody {
    body(id, json!({ "id": id, "title": title, "clusterIds": [], "position": { "x": 0, "y": 0 } }))
  }

  fn meta(title: &str) -> BoardMeta {
    BoardMeta { title: title.into(), updated_at: "2026-07-19T00:00:00.000Z".into(), country_code: None }
  }

  const VIEWPORT: Viewport = Viewport { x: 0.0, y: 0.0, zoom: 1.0 };

  /// A board of only cards, so the order/delete tests read at a glance. Connections
  /// and clusters take the same `write_table` path, exercised by the round-trip test.
  fn card_payload(cards: &[&str], ids: &[&str], viewport: Option<Viewport>) -> SaveBoardPayload {
    SaveBoardPayload {
      version: 4,
      meta: meta("t"),
      viewport,
      cards: cards.iter().map(|id| card(id, id)).collect(),
      card_ids: ids.iter().map(|s| s.to_string()).collect(),
      connections: vec![],
      connection_ids: vec![],
      clusters: vec![],
      cluster_ids: vec![],
      media_refs: vec![],
    }
  }

  /// A whole board as the webview sends it on a first save: every body, every id.
  pub(super) fn full_payload(board: &Board) -> SaveBoardPayload {
    fn bodies<T: Serialize>(xs: &[T], id: impl Fn(&T) -> &str) -> (Vec<BoardBody>, Vec<String>) {
      xs.iter().map(|x| (body(id(x), serde_json::to_value(x).unwrap()), id(x).to_string())).unzip()
    }
    let (cards, card_ids) = bodies(&board.cards, |c| &c.id);
    let (connections, connection_ids) = bodies(&board.connections, |c| &c.id);
    let (clusters, cluster_ids) = bodies(&board.clusters, |c| &c.id);
    SaveBoardPayload {
      version: board.version,
      meta: board.meta.clone(),
      viewport: board.viewport,
      cards,
      card_ids,
      connections,
      connection_ids,
      clusters,
      cluster_ids,
      media_refs: vec![],
    }
  }

  fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_board_schema(&conn).unwrap();
    conn
  }

  fn apply(conn: &mut Connection, p: &SaveBoardPayload) {
    let tx = conn.transaction().unwrap();
    write_board_tx(&tx, p).unwrap();
    tx.commit().unwrap();
  }

  fn read(conn: &Connection) -> Board {
    reassemble_board(conn).unwrap()
  }

  fn card_ids(board: &Board) -> Vec<&str> {
    board.cards.iter().map(|c| c.id.as_str()).collect()
  }

  #[test]
  fn round_trips_a_board() {
    let mut conn = fresh();
    let mut payload = card_payload(&[], &["c1", "c2"], Some(Viewport { x: 1.0, y: 2.0, zoom: 1.5 }));
    payload.meta = meta("Case");
    payload.cards = vec![card("c1", "A"), card("c2", "B")];
    payload.connections = vec![body("e1", json!({ "id": "e1", "source": "c1", "target": "c2" }))];
    payload.connection_ids = vec!["e1".into()];
    payload.clusters = vec![body("g1", json!({ "id": "g1", "label": "grp", "color": "#fff", "visible": true }))];
    payload.cluster_ids = vec!["g1".into()];
    apply(&mut conn, &payload);
    let board = read(&conn);
    assert_eq!(board.version, 4);
    assert_eq!(board.meta.title, "Case");
    assert_eq!(card_ids(&board), vec!["c1", "c2"]);
    assert_eq!(board.cards[0].title, "A");
    assert_eq!(board.connections[0].id, "e1");
    assert_eq!(board.clusters[0].id, "g1");
    assert_eq!(board.viewport.unwrap().zoom, 1.5);
  }

  #[test]
  fn deletes_rows_absent_from_the_id_list() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&["a", "b"], &["a", "b"], None));
    // A save that no longer lists b removes it, even though no body is re-sent for a.
    apply(&mut conn, &card_payload(&[], &["a"], None));
    assert_eq!(card_ids(&read(&conn)), vec!["a"]);
  }

  #[test]
  fn preserves_order_after_a_mid_list_delete() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&["a", "b", "c"], &["a", "b", "c"], None));
    // Drop the middle row and re-send only the order — the surviving rows keep a,c.
    apply(&mut conn, &card_payload(&[], &["a", "c"], None));
    assert_eq!(card_ids(&read(&conn)), vec!["a", "c"]);
  }

  #[test]
  fn empty_board_has_empty_arrays_and_no_viewport() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&[], &[], None));
    let board = read(&conn);
    assert!(board.cards.is_empty() && board.connections.is_empty() && board.clusters.is_empty());
    assert_eq!(board.viewport, None);
    assert_eq!(board.meta.title, "t");
  }

  #[test]
  fn viewport_is_dropped_when_a_later_save_omits_it() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&[], &[], Some(VIEWPORT)));
    assert!(read(&conn).viewport.is_some());
    apply(&mut conn, &card_payload(&[], &[], None));
    assert!(read(&conn).viewport.is_none());
  }

  #[test]
  fn a_save_stores_each_body_validated_and_canonical() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&["a"], &["a"], None));
    let stored: String = conn.query_row("SELECT json FROM cards WHERE id='a'", [], |r| r.get(0)).unwrap();
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["kind"], "evidence");
    assert_eq!(stored["notes"], "");
  }

  #[test]
  fn a_save_with_an_invalid_body_writes_nothing() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&["a"], &["a"], None));
    for bad in [
      body("b", json!({ "id": "b", "title": "B", "clusterIds": [], "position": { "x": 0, "y": 0 }, "kind": "suspect" })),
      body("b", json!({ "id": "b" })),
      body("b", json!({ "id": "other", "title": "B", "clusterIds": [], "position": { "x": 0, "y": 0 } })),
      BoardBody { id: "b".into(), json: "not json".into() },
    ] {
      let mut p = card_payload(&[], &["b"], None);
      p.cards = vec![bad];
      let tx = conn.transaction().unwrap();
      assert!(write_board_tx(&tx, &p).is_err());
    }
    let mut p = card_payload(&[], &[], None);
    p.version = 3;
    assert!(write_board_tx(&conn.transaction().unwrap(), &p).is_err());
    assert_eq!(card_ids(&read(&conn)), vec!["a"]);
  }

  #[test]
  fn a_board_saved_by_an_older_build_reassembles_migrated() {
    let conn = fresh();
    conn
      .execute_batch(
        r#"INSERT INTO meta VALUES ('version','3'), ('meta','{"title":"Old","updatedAt":"x"}'), ('card_order','["a"]');
           INSERT INTO cards VALUES ('a','{"id":"a","title":"A","notes":"","imageUrl":null,"clusterId":"g","position":{"x":0,"y":0},"kind":"email","email":{"attachments":["r.pdf"]}}');"#,
      )
      .unwrap();
    let board = read(&conn);
    assert_eq!(board.version, 4);
    assert_eq!(board.cards[0].cluster_ids, vec!["g"]);
    assert_eq!(board.cards[0].email.as_ref().unwrap().attachments[0].name, "r.pdf");
  }

  /// Every fixture, saved as the webview would and read back, is the board it was.
  #[test]
  fn fixture_boards_survive_a_save_and_reload() {
    for text in [
      include_str!("../../tests/fixtures/boards/v1.json"),
      include_str!("../../tests/fixtures/boards/v2-email.json"),
      include_str!("../../tests/fixtures/boards/v3-entities.json"),
      include_str!("../../tests/fixtures/boards/v4-current.json"),
    ] {
      let board = parse_board_json(text).unwrap();
      let mut conn = fresh();
      apply(&mut conn, &full_payload(&board));
      assert_eq!(read(&conn), board);
    }
  }

  /// The whole point of the swap, on a real file: a save committed through one
  /// connection is durable and readable by the next, which the in-memory tests can't
  /// show (WAL, the checkpoint, and reopening the file all only exist on disk).
  #[test]
  fn persists_to_a_real_file_across_connections() {
    let dir = temp_dir_for("persist");
    let path = dir.join("brd_test.sqlite");
    {
      let mut conn = open_board_db(&path).unwrap();
      let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
      let mut payload = card_payload(&[], &["a"], Some(VIEWPORT));
      payload.cards = vec![card("a", "Kept")];
      write_board_tx(&tx, &payload).unwrap();
      tx.commit().unwrap();
      let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    } // the connection drops here — the file is closed

    // A brand-new connection, i.e. the file reopened, sees the committed board.
    let board = read_board_db(&path).unwrap();
    assert_eq!(card_ids(&board), vec!["a"]);
    assert_eq!(board.cards[0].title, "Kept");
    assert!(board.viewport.is_some());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_save_replaces_the_recorded_refs() {
    let mut conn = fresh();
    assert_eq!(recorded_refs(&conn).unwrap(), None);
    let mut p = card_payload(&[], &[], None);
    p.media_refs = vec!["a.png".into(), "b.pdf".into(), "a.png".into()];
    apply(&mut conn, &p);
    p.media_refs = vec!["b.pdf".into()];
    apply(&mut conn, &p);
    assert_eq!(recorded_refs(&conn).unwrap(), Some(vec!["b.pdf".to_string()]));
  }

  #[test]
  fn recording_refs_never_overwrites_a_save() {
    let mut conn = fresh();
    record_if_unrecorded(&mut conn, &["old.png".into()]).unwrap();
    assert_eq!(recorded_refs(&conn).unwrap(), Some(vec!["old.png".to_string()]));
    let mut p = card_payload(&[], &[], None);
    p.media_refs = vec!["new.png".into()];
    apply(&mut conn, &p);
    record_if_unrecorded(&mut conn, &["stale.png".into()]).unwrap();
    assert_eq!(recorded_refs(&conn).unwrap(), Some(vec!["new.png".to_string()]));
  }

  #[test]
  fn library_refs_name_every_board_they_cannot_vouch_for() {
    let dir = temp_dir_for("library-refs");
    save_board_file(&dir.join("brd_saved.sqlite"), Some(&["a.png", "b.pdf"]));
    save_board_file(&dir.join("brd_other.sqlite"), Some(&["b.pdf", "c.eml"]));
    save_board_file(&dir.join("brd_old.sqlite"), None);
    std::fs::write(dir.join("brd_legacy.json"), "{}").unwrap();
    std::fs::write(dir.join("brd_saved.json"), "{}").unwrap(); // migrated, not yet retired
    std::fs::write(dir.join("brd_corrupt.sqlite"), "not a database").unwrap();
    std::fs::write(dir.join("brd_saved.sqlite-wal"), "").unwrap();

    std::fs::create_dir(dir.join("brd_dir")).unwrap();
    let listed = ["brd_saved".to_string(), "brd_gone".to_string()];
    let refs = library_media_refs(&dir, &listed, None).unwrap();
    let mut unknown = refs.unknown.clone();
    unknown.sort();
    assert_eq!(unknown, vec!["brd_corrupt", "brd_gone", "brd_legacy", "brd_old"]);
    let mut names: Vec<_> = refs.names.into_iter().collect();
    names.sort();
    assert_eq!(names, vec!["a.png", "b.pdf", "c.eml"]);

    let except = library_media_refs(&dir, &[], Some("brd_other")).unwrap();
    assert!(!except.names.contains("c.eml"));
    assert!(library_media_refs(&dir.join("absent"), &[], None).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }
}

/// A board database on disk with its refs recorded, or (None) saved before refs were.
#[cfg(test)]
pub(super) fn save_board_file(path: &Path, refs: Option<&[&str]>) {
  let mut conn = open_board_db(path).unwrap();
  let tx = conn.transaction().unwrap();
  match refs {
    Some(refs) => write_media_refs(&tx, &refs.iter().map(|r| r.to_string()).collect::<Vec<_>>()).unwrap(),
    None => upsert_meta(&tx, "meta", "{}").unwrap(),
  }
  tx.commit().unwrap();
}

#[cfg(test)]
pub(super) fn write_board_file(path: &Path, board: &Board) {
  let mut payload = tests::full_payload(board);
  payload.media_refs = board.cards.iter().flat_map(schema::Card::media_files).map(String::from).collect();
  let mut conn = open_board_db(path).unwrap();
  let tx = conn.transaction().unwrap();
  write_board_tx(&tx, &payload).unwrap();
  tx.commit().unwrap();
}
