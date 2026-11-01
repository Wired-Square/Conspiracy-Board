//! Per-board SQLite.
//!
//! One database per board (boards/<id>.sqlite). A board is written whole only when it
//! is created (`create_boards`, or a legacy `boards/<id>.json` on first use); after that
//! the open-board session (`session`) edits it a row at a time. `load_board`
//! reassembles the rows and returns the validated, migrated board.
//!
//! A board's cards, connections and clusters are one `(id, json)` row each, so an
//! edit writes only the rows it changed, and a crash can't tear the file (WAL + one
//! transaction per write). Rust owns the board and its cards: the schema is
//! `crate::schema`, and the webview's types are generated from it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::board_index::{listed_ids, remove_summary, upsert_summary};
use super::session::OpenBoard;
use super::{boards_dir, open_read_only, read_opt, remove_if_present, run_open};
use crate::library_index::LibraryDb;
use crate::quit;
use crate::schema::{parse_board, parse_board_json, Board, Card, BOARD_VERSION};

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

/// The database and its `-wal`/`-shm` sidecars, which live in `boards/` where the
/// media sweep never looks.
fn remove_board_db(path: &Path) -> Result<(), String> {
  for suffix in ["", "-wal", "-shm"] {
    let mut file = path.as_os_str().to_os_string();
    file.push(suffix);
    remove_if_present(Path::new(&file))?;
  }
  Ok(())
}

/// Open (creating if absent) a board database with the tables and pragmas it needs.
/// WAL so a reader never blocks the writer and a crash can't tear the file;
/// `synchronous=NORMAL` paired with a checkpoint after a whole-board write (see
/// `create_board_db`); `busy_timeout` so a second app instance retries rather than
/// failing.
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

/// The board's database, or None if it has none and no legacy `boards/<id>.json` to
/// make one from.
pub(super) fn board_db(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
  let db = board_db_file(app, id)?;
  let _held = quit::hold(app);
  Ok(ensure_from_legacy(&db, &board_file(app, id)?)?.then_some(db))
}

/// Whether `db` exists, made from `legacy` if it didn't. The JSON is removed only once
/// the database reassembles.
fn ensure_from_legacy(db: &Path, legacy: &Path) -> Result<bool, String> {
  if db.exists() {
    return Ok(true);
  }
  let Some(json) = read_opt(legacy.to_path_buf())? else { return Ok(false) };
  create_board_db(db, &parse_board_json(&json)?)?;
  read_board_db(db)?;
  remove_if_present(legacy)?;
  Ok(true)
}

/// A board read without writing anything, not even a legacy board's migration.
pub(crate) fn peek_board(boards: &Path, id: &str) -> Result<Option<Board>, String> {
  if !valid_board_id(id) {
    return Err(format!("Not a usable board id: {id:?}"));
  }
  let db = boards.join(format!("{id}.sqlite"));
  if db.exists() {
    return reassemble_board(&open_read_only(&db)?).map(Some);
  }
  read_opt(boards.join(format!("{id}.json")))?.map(|json| parse_board_json(&json)).transpose()
}

#[tauri::command(async)]
pub fn load_board(app: AppHandle, id: String) -> Result<Option<Board>, String> {
  board_db(&app, &id)?.map(|db| read_board_db(&db)).transpose()
}

/// The bundled seed board, for a library with nothing in it yet.
#[tauri::command(async)]
pub fn seed_board() -> Result<Board, String> {
  parse_board_json(include_str!("../../../data/board.json"))
}

#[derive(Deserialize)]
pub struct NewBoard {
  id: String,
  board: Value,
}

/// New boards, each written whole, then listed: a board is never listed before it can
/// be opened.
#[tauri::command(async)]
pub fn create_boards(app: AppHandle, library: State<LibraryDb>, boards: Vec<NewBoard>) -> Result<(), String> {
  let _held = quit::hold(&app);
  let boards = boards
    .into_iter()
    .map(|new| Ok((board_db_file(&app, &new.id)?, new.id, parse_board(new.board)?)))
    .collect::<Result<Vec<_>, String>>()?;
  create_board_dbs(boards.iter().map(|(path, _, board)| (path.as_path(), board)))?;
  let library = library.lock_db()?;
  boards.iter().try_for_each(|(_, id, board)| upsert_summary(&library, id, &board.meta.title, &board.meta.updated_at))
}

/// Every board or none: a failed write removes the ones already made.
fn create_board_dbs<'a>(boards: impl IntoIterator<Item = (&'a Path, &'a Board)>) -> Result<(), String> {
  let mut made = Vec::new();
  for (path, board) in boards {
    if let Err(e) = create_board_db(path, board) {
      made.into_iter().try_for_each(remove_board_db)?;
      return Err(e);
    }
    made.push(path);
  }
  Ok(())
}

/// Refuses a database that already exists, and leaves none behind when the write fails.
pub(crate) fn create_board_db(path: &Path, board: &Board) -> Result<(), String> {
  if path.exists() {
    return Err("That board already exists.".into());
  }
  let written = open_board_db(path).and_then(|mut conn| {
    let tx = conn
      .transaction_with_behavior(TransactionBehavior::Immediate)
      .map_err(|e| format!("Could not begin the save: {e}"))?;
    write_board(&tx, board)?;
    tx.commit().map_err(|e| format!("Could not save the board: {e}"))?;
    // Folds the WAL back and fsyncs, so the new board is durable in its own file.
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(())
  });
  if written.is_err() {
    remove_board_db(path)?;
  }
  written
}

fn write_board(tx: &Transaction, board: &Board) -> Result<(), String> {
  upsert_meta(tx, "version", &BOARD_VERSION.to_string())?;
  upsert_meta(tx, "meta", &to_json(&board.meta)?)?;
  if let Some(viewport) = &board.viewport {
    upsert_meta(tx, "viewport", &to_json(viewport)?)?;
  }
  write_rows(tx, "cards", "card_order", &board.cards, |c| &c.id)?;
  write_rows(tx, "connections", "connection_order", &board.connections, |c| &c.id)?;
  write_rows(tx, "clusters", "cluster_order", &board.clusters, |c| &c.id)?;
  let refs: Vec<String> = board.cards.iter().flat_map(Card::media_files).map(String::from).collect();
  write_media_refs(tx, &refs)
}

fn write_rows<T: Serialize>(
  tx: &Transaction,
  table: &str,
  order_key: &str,
  rows: &[T],
  id: impl Fn(&T) -> &str,
) -> Result<(), String> {
  let bodies = rows.iter().map(|r| Ok((id(r), to_json(r)?))).collect::<Result<Vec<_>, String>>()?;
  upsert_rows(tx, table, bodies.iter().map(|(id, json)| (*id, json.as_str())))?;
  upsert_meta(tx, order_key, &to_json(&bodies.iter().map(|(id, _)| *id).collect::<Vec<_>>())?)
}

pub(super) fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, String> {
  serde_json::from_value(value).map_err(|e| format!("Not a valid board row: {e}"))
}

/// The media names the board's cards link, which the sweep keeps. The `media_refs` meta row marks them as
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

/// `table` is always one of the three literals this module and `session` pass, never
/// caller input, so formatting it into the statement carries no injection surface; ids
/// and json are bound parameters.
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
  // before a board is first written there is nothing to show, and saying so beats Finder
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
  remove_board_db(&board_db_file(&app, &id)?)?;
  remove_if_present(&board_file(&app, &id)?)?;
  remove_summary(&*library.lock_db()?, &id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::temp_dir_for;

  fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_board_schema(&conn).unwrap();
    conn
  }

  fn read(conn: &Connection) -> Board {
    reassemble_board(conn).unwrap()
  }

  fn in_temp(name: &str, test: impl FnOnce(&Path)) {
    let dir = temp_dir_for(name);
    test(&dir.join("brd_test.sqlite"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  fn board(title: &str, cards: Value) -> Board {
    let meta = json!({ "title": title, "updatedAt": "x" });
    parse_board(json!({ "version": 4, "meta": meta, "cards": cards, "connections": [], "clusters": [] })).unwrap()
  }

  /// Every fixture, created and read back through a fresh connection, is the board it was.
  #[test]
  fn fixture_boards_survive_creation_and_reload() {
    for text in [
      include_str!("../../tests/fixtures/boards/v1.json"),
      include_str!("../../tests/fixtures/boards/v2-email.json"),
      include_str!("../../tests/fixtures/boards/v3-entities.json"),
      include_str!("../../tests/fixtures/boards/v4-current.json"),
    ] {
      let board = parse_board_json(text).unwrap();
      in_temp("create-fixture", |path| {
        create_board_db(path, &board).unwrap();
        assert_eq!(read_board_db(path).unwrap(), board);
      });
    }
  }

  #[test]
  fn empty_board_has_empty_arrays_and_no_viewport() {
    in_temp("create-empty", |path| {
      create_board_db(path, &board("t", json!([]))).unwrap();
      let read = read_board_db(path).unwrap();
      assert!(read.cards.is_empty() && read.connections.is_empty() && read.clusters.is_empty());
      assert_eq!(read.viewport, None);
      assert_eq!(read.meta.title, "t");
    });
  }

  #[test]
  fn creating_never_overwrites_a_board() {
    in_temp("create-twice", |path| {
      create_board_db(path, &board("First", json!([]))).unwrap();
      assert!(create_board_db(path, &board("Second", json!([]))).is_err());
      assert_eq!(read_board_db(path).unwrap().meta.title, "First");
    });
  }

  #[test]
  fn creating_several_boards_makes_all_or_none() {
    let dir = temp_dir_for("create-several");
    let (one, two) = (dir.join("brd_one.sqlite"), dir.join("brd_two.sqlite"));
    let (first, second) = (board("First", json!([])), board("Second", json!([])));
    create_board_dbs([(one.as_path(), &first), (two.as_path(), &second)]).unwrap();
    assert_eq!(read_board_db(&two).unwrap().meta.title, "Second");

    let three = dir.join("brd_three.sqlite");
    assert!(create_board_dbs([(three.as_path(), &first), (one.as_path(), &second)]).is_err());
    assert!(!three.exists());
    assert_eq!(read_board_db(&one).unwrap().meta.title, "First");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn creating_records_the_cards_media_refs() {
    in_temp("create-refs", |path| {
      let with_media = board(
        "t",
        json!([
          { "id": "a", "title": "A", "clusterIds": [], "position": { "x": 0, "y": 0 }, "imageFile": "a.png" },
          { "id": "b", "title": "B", "clusterIds": [], "position": { "x": 0, "y": 0 }, "document": { "file": "b.pdf" } },
        ]),
      );
      create_board_db(path, &with_media).unwrap();
      let mut refs = recorded_refs(&Connection::open(path).unwrap()).unwrap().unwrap();
      refs.sort();
      assert_eq!(refs, ["a.png", "b.pdf"]);
    });
  }

  #[test]
  fn a_legacy_board_becomes_a_database_and_its_json_goes() {
    let dir = temp_dir_for("legacy");
    let (db, legacy) = (dir.join("brd_old.sqlite"), dir.join("brd_old.json"));
    let text = include_str!("../../tests/fixtures/boards/v3-entities.json");
    std::fs::write(&legacy, text).unwrap();
    assert!(ensure_from_legacy(&db, &legacy).unwrap());
    assert_eq!(read_board_db(&db).unwrap(), parse_board_json(text).unwrap());
    assert!(!legacy.exists());
    assert!(ensure_from_legacy(&db, &legacy).unwrap());

    let (none, unreadable) = (dir.join("brd_none.sqlite"), dir.join("brd_bad.json"));
    assert!(!ensure_from_legacy(&none, &dir.join("brd_none.json")).unwrap());
    std::fs::write(&unreadable, "{").unwrap();
    assert!(ensure_from_legacy(&dir.join("brd_bad.sqlite"), &unreadable).is_err());
    assert!(unreadable.exists() && !dir.join("brd_bad.sqlite").exists() && !none.exists());
    let _ = std::fs::remove_dir_all(&dir);
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

  #[test]
  fn recording_refs_never_overwrites_recorded_ones() {
    let mut conn = fresh();
    assert_eq!(recorded_refs(&conn).unwrap(), None);
    record_if_unrecorded(&mut conn, &["old.png".into()]).unwrap();
    record_if_unrecorded(&mut conn, &["stale.png".into()]).unwrap();
    assert_eq!(recorded_refs(&conn).unwrap(), Some(vec!["old.png".to_string()]));
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
