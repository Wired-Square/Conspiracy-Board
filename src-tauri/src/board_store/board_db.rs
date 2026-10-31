//! Per-board SQLite.
//!
//! One database per board (boards/<id>.sqlite). The webview hands `save_board` the
//! board split into rows — each card/connection/cluster as `{ id, json }`, plus the
//! complete ordered id lists and the envelope's small parts — and this side upserts
//! the bodies and deletes any row whose id is no longer present, all in one
//! transaction. `load_board` reassembles the exact board JSON the schema expects,
//! passing each stored fragment through untouched. The extension is `.sqlite`; the
//! old `boards/<id>.json` is read once, on first open, and migrated (see the seam in
//! src/storage/tauriStorage.ts, which then calls `retire_legacy_board`).
//!
//! A board's cards, connections and clusters are one `(id, json)` row each, so a
//! save writes only the rows that changed rather than rewriting the whole board, and
//! a crash can't tear the file (WAL + one transaction per save). The rule the old
//! single-file store kept still holds: Rust owns the board *envelope* — the five
//! top-level keys, and which id belongs to which table — and TypeScript owns the
//! *card*. The `json` column is a card's bytes, passed through verbatim on the way
//! out (`serde_json`'s `RawValue`) and never parsed here; the schema stays in
//! TypeScript (`src/data/schema.ts`), its one canonical definition.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::value::RawValue;

use super::{boards_dir, read_opt, remove_if_present, run_open};

/// Whether an id is safe to reach the filesystem as a filename. Ids are generated
/// as `brd_<hex>` (`src/lib/ids.ts`), so this rejects nothing legitimate; it exists
/// because an id arrives as a filename from `index.json` (an ordinary file a user
/// can hand-edit) or a bundle's `boards/<id>.json` entry name — without it, an id of
/// `../../../etc/something` would be honoured. `board_file` and the bundle reader
/// both go through it, so one rule covers every path an id takes to disk.
pub(super) fn valid_board_id(id: &str) -> bool {
  !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn board_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !valid_board_id(id) {
    return Err(format!("Not a usable board id: {id:?}"));
  }
  Ok(boards_dir(app)?.join(format!("{id}.json")))
}

fn board_db_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
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
#[serde(rename_all = "camelCase")]
pub struct SaveBoardPayload {
  version: i64,
  meta: String,
  viewport: Option<String>,
  cards: Vec<BoardBody>,
  card_ids: Vec<String>,
  connections: Vec<BoardBody>,
  connection_ids: Vec<String>,
  clusters: Vec<BoardBody>,
  cluster_ids: Vec<String>,
  media_refs: Vec<String>,
}

/// A single entity to upsert: its id (the envelope's, this side's) and its JSON (the
/// card's, TypeScript's, opaque here).
#[derive(serde::Deserialize)]
pub struct BoardBody {
  id: String,
  json: String,
}

/// What `load_board` returns: the reassembled board JSON (or None on first run), and
/// whether it came from a legacy `boards/<id>.json` that the seam should now migrate.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedBoard {
  json: Option<String>,
  legacy: bool,
}

#[tauri::command(async)]
pub fn load_board(app: AppHandle, id: String) -> Result<LoadedBoard, String> {
  let db = board_db_file(&app, &id)?;
  if db.exists() {
    return Ok(LoadedBoard { json: Some(read_board_db(&db)?), legacy: false });
  }
  // No database yet: a legacy JSON board is offered for the seam to migrate; nothing
  // at all is first run.
  match read_opt(board_file(&app, &id)?)? {
    Some(json) => Ok(LoadedBoard { json: Some(json), legacy: true }),
    None => Ok(LoadedBoard { json: None, legacy: false }),
  }
}

#[tauri::command(async)]
pub fn save_board(app: AppHandle, id: String, payload: SaveBoardPayload) -> Result<(), String> {
  let mut conn = open_board_db(&board_db_file(&app, &id)?)?;
  let tx = conn
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|e| format!("Could not begin the save: {e}"))?;
  write_board_tx(&tx, &payload)?;
  tx.commit().map_err(|e| format!("Could not save the board: {e}"))?;
  // Fold the WAL back into the main file and fsync, so a completed save is durable in
  // boards/<id>.sqlite before this returns and the sidecars are normally absent.
  let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
  Ok(())
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

/// Upsert the envelope and every provided body, then delete any row whose id the
/// caller no longer lists — the whole board in one transaction.
fn write_board_tx(tx: &Transaction, p: &SaveBoardPayload) -> Result<(), String> {
  upsert_meta(tx, "version", &p.version.to_string())?;
  upsert_meta(tx, "meta", &p.meta)?;
  upsert_meta(tx, "card_order", &order_json(&p.card_ids)?)?;
  upsert_meta(tx, "connection_order", &order_json(&p.connection_ids)?)?;
  upsert_meta(tx, "cluster_order", &order_json(&p.cluster_ids)?)?;
  match &p.viewport {
    Some(v) => upsert_meta(tx, "viewport", v)?,
    None => {
      tx.execute("DELETE FROM meta WHERE key='viewport'", [])
        .map_err(|e| format!("Could not clear the viewport: {e}"))?;
    }
  }
  write_table(tx, "cards", &p.cards, &p.card_ids)?;
  write_table(tx, "connections", &p.connections, &p.connection_ids)?;
  write_table(tx, "clusters", &p.clusters, &p.cluster_ids)?;
  write_media_refs(tx, &p.media_refs)
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
#[serde(rename_all = "camelCase")]
pub struct LibraryRefs {
  pub names: HashSet<String>,
  pub unknown: Vec<String>,
}

pub(crate) fn library_media_refs(boards: &Path, except: Option<&str>) -> Result<LibraryRefs, String> {
  let entries = std::fs::read_dir(boards).map_err(|e| format!("Could not read the boards directory: {e}"))?;
  let mut refs = LibraryRefs::default();
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
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
  conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
  recorded_refs(&conn).ok().flatten()
}

/// The media refs of every board but `except` (the open one, whose live refs the
/// caller already has), for the maintenance audit.
#[tauri::command(async)]
pub fn media_refs(app: AppHandle, except: Option<String>) -> Result<LibraryRefs, String> {
  library_media_refs(&boards_dir(&app)?, except.as_deref())
}

fn order_json(ids: &[String]) -> Result<String, String> {
  serde_json::to_string(ids).map_err(|e| format!("Could not record board order: {e}"))
}

fn upsert_meta(tx: &Transaction, key: &str, value: &str) -> Result<(), String> {
  tx.execute(
    "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    rusqlite::params![key, value],
  )
  .map_err(|e| format!("Could not save board metadata: {e}"))?;
  Ok(())
}

/// `table` is always one of the three literals this module passes — never caller
/// input — so formatting it into the statement carries no injection surface; ids and
/// json are bound parameters.
fn write_table(tx: &Transaction, table: &str, bodies: &[BoardBody], ids: &[String]) -> Result<(), String> {
  {
    let sql = format!("INSERT INTO {table}(id,json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json");
    let mut stmt = tx.prepare(&sql).map_err(|e| format!("Could not prepare a board write: {e}"))?;
    for b in bodies {
      stmt
        .execute(rusqlite::params![b.id, b.json])
        .map_err(|e| format!("Could not write a board row: {e}"))?;
    }
  }
  let keep: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
  let present: Vec<String> = {
    let mut stmt = tx
      .prepare(&format!("SELECT id FROM {table}"))
      .map_err(|e| format!("Could not read board rows: {e}"))?;
    stmt
      .query_map([], |r| r.get::<_, String>(0))
      .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
      .map_err(|e| format!("Could not read board rows: {e}"))?
  };
  {
    let mut del = tx
      .prepare(&format!("DELETE FROM {table} WHERE id=?1"))
      .map_err(|e| format!("Could not prepare a board delete: {e}"))?;
    for id in &present {
      if !keep.contains(id.as_str()) {
        del.execute(rusqlite::params![id]).map_err(|e| format!("Could not delete a board row: {e}"))?;
      }
    }
  }
  Ok(())
}

fn read_board_db(path: &Path) -> Result<String, String> {
  reassemble_board(&open_board_db(path)?)
}

/// The board envelope, ready to serialise. Each fragment is a `RawValue` — the stored
/// card/connection/cluster/meta JSON passed through verbatim (validated as JSON, never
/// interpreted). Field order matches the `Board` interface, though the schema does not
/// depend on it.
#[derive(serde::Serialize)]
struct BoardEnvelope<'a> {
  version: i64,
  meta: &'a RawValue,
  clusters: Vec<&'a RawValue>,
  cards: Vec<&'a RawValue>,
  connections: Vec<&'a RawValue>,
  #[serde(skip_serializing_if = "Option::is_none")]
  viewport: Option<&'a RawValue>,
}

fn reassemble_board(conn: &Connection) -> Result<String, String> {
  let meta = read_meta(conn)?;
  let version: i64 = meta.get("version").and_then(|v| v.parse().ok()).unwrap_or(3);
  let meta_box = raw(meta.get("meta").map(String::as_str).unwrap_or("{}"))?;
  let viewport_box = match meta.get("viewport") {
    Some(v) => Some(raw(v)?),
    None => None,
  };
  let cards = ordered_bodies(conn, "cards", meta.get("card_order"))?;
  let connections = ordered_bodies(conn, "connections", meta.get("connection_order"))?;
  let clusters = ordered_bodies(conn, "clusters", meta.get("cluster_order"))?;

  let env = BoardEnvelope {
    version,
    meta: &meta_box,
    clusters: clusters.iter().map(|b| &**b).collect(),
    cards: cards.iter().map(|b| &**b).collect(),
    connections: connections.iter().map(|b| &**b).collect(),
    viewport: viewport_box.as_deref(),
  };
  serde_json::to_string(&env).map_err(|e| format!("Could not assemble the board: {e}"))
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

/// Every row of a table as `RawValue` bodies, in the order the id list gives. An id in
/// the order list with no row is skipped; a row missing from the list is still emitted
/// (after the ordered ones), so a reassembly is lossless even if the two ever disagree.
fn ordered_bodies(conn: &Connection, table: &str, order: Option<&String>) -> Result<Vec<Box<RawValue>>, String> {
  let bodies: HashMap<String, String> = {
    let mut stmt = conn
      .prepare(&format!("SELECT id, json FROM {table}"))
      .map_err(|e| format!("Could not read board rows: {e}"))?;
    stmt
      .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
      .and_then(|rows| rows.collect::<rusqlite::Result<HashMap<_, _>>>())
      .map_err(|e| format!("Could not read board rows: {e}"))?
  };
  let ids: Vec<String> = order.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
  let mut out: Vec<Box<RawValue>> = Vec::with_capacity(bodies.len());
  let mut used: std::collections::HashSet<&str> = std::collections::HashSet::new();
  for id in &ids {
    if let Some(json) = bodies.get(id) {
      out.push(raw(json)?);
      used.insert(id.as_str());
    }
  }
  for (id, json) in &bodies {
    if !used.contains(id.as_str()) {
      out.push(raw(json)?);
    }
  }
  Ok(out)
}

fn raw(s: &str) -> Result<Box<RawValue>, String> {
  RawValue::from_string(s.to_string()).map_err(|e| format!("A stored board fragment was not valid JSON: {e}"))
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
#[tauri::command(async)]
pub fn delete_board(app: AppHandle, id: String) -> Result<(), String> {
  let db = board_db_file(&app, &id)?;
  remove_if_present(&db)?;
  remove_if_present(&db_sidecar(&db, "-wal"))?;
  remove_if_present(&db_sidecar(&db, "-shm"))?;
  remove_if_present(&board_file(&app, &id)?)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::temp_dir_for;

  fn body(id: &str, json: &str) -> BoardBody {
    BoardBody { id: id.to_string(), json: json.to_string() }
  }

  /// A board of only cards, so the order/delete tests read at a glance. Connections
  /// and clusters take the same `write_table` path, exercised by the round-trip test.
  fn card_payload(cards: &[(&str, &str)], ids: &[&str], viewport: Option<&str>) -> SaveBoardPayload {
    SaveBoardPayload {
      version: 3,
      meta: r#"{"title":"t","updatedAt":"x"}"#.to_string(),
      viewport: viewport.map(str::to_string),
      cards: cards.iter().map(|(id, j)| body(id, j)).collect(),
      card_ids: ids.iter().map(|s| s.to_string()).collect(),
      connections: vec![],
      connection_ids: vec![],
      clusters: vec![],
      cluster_ids: vec![],
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

  fn read(conn: &Connection) -> serde_json::Value {
    serde_json::from_str(&reassemble_board(conn).unwrap()).unwrap()
  }

  fn card_ids(v: &serde_json::Value) -> Vec<String> {
    v["cards"]
      .as_array()
      .unwrap()
      .iter()
      .map(|c| c["id"].as_str().unwrap().to_string())
      .collect()
  }

  #[test]
  fn round_trips_a_board() {
    let mut conn = fresh();
    apply(
      &mut conn,
      &SaveBoardPayload {
        version: 3,
        meta: r#"{"title":"Case","updatedAt":"2026-07-19T00:00:00.000Z"}"#.to_string(),
        viewport: Some(r#"{"x":1.0,"y":2.0,"zoom":1.5}"#.to_string()),
        cards: vec![body("c1", r#"{"id":"c1","title":"A"}"#), body("c2", r#"{"id":"c2","title":"B"}"#)],
        card_ids: vec!["c1".into(), "c2".into()],
        connections: vec![body("e1", r#"{"id":"e1","source":"c1","target":"c2"}"#)],
        connection_ids: vec!["e1".into()],
        clusters: vec![body("g1", r#"{"id":"g1","label":"grp"}"#)],
        cluster_ids: vec!["g1".into()],
        media_refs: vec![],
      },
    );
    let v = read(&conn);
    assert_eq!(v["version"], 3);
    assert_eq!(v["meta"]["title"], "Case");
    assert_eq!(card_ids(&v), vec!["c1", "c2"]);
    assert_eq!(v["cards"][0]["title"], "A");
    assert_eq!(v["connections"][0]["id"], "e1");
    assert_eq!(v["clusters"][0]["id"], "g1");
    assert_eq!(v["viewport"]["zoom"], 1.5);
  }

  #[test]
  fn deletes_rows_absent_from_the_id_list() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&[("a", r#"{"id":"a"}"#), ("b", r#"{"id":"b"}"#)], &["a", "b"], None));
    // A save that no longer lists b removes it, even though no body is re-sent for a.
    apply(&mut conn, &card_payload(&[], &["a"], None));
    assert_eq!(card_ids(&read(&conn)), vec!["a"]);
  }

  #[test]
  fn preserves_order_after_a_mid_list_delete() {
    let mut conn = fresh();
    apply(
      &mut conn,
      &card_payload(&[("a", r#"{"id":"a"}"#), ("b", r#"{"id":"b"}"#), ("c", r#"{"id":"c"}"#)], &["a", "b", "c"], None),
    );
    // Drop the middle row and re-send only the order — the surviving rows keep a,c.
    apply(&mut conn, &card_payload(&[], &["a", "c"], None));
    assert_eq!(card_ids(&read(&conn)), vec!["a", "c"]);
  }

  #[test]
  fn empty_board_has_empty_arrays_and_no_viewport() {
    let v = {
      let mut conn = fresh();
      apply(&mut conn, &card_payload(&[], &[], None));
      read(&conn)
    };
    assert!(v["cards"].as_array().unwrap().is_empty());
    assert!(v["connections"].as_array().unwrap().is_empty());
    assert!(v["clusters"].as_array().unwrap().is_empty());
    assert!(v.get("viewport").is_none());
    assert_eq!(v["meta"]["title"], "t");
  }

  #[test]
  fn viewport_is_dropped_when_a_later_save_omits_it() {
    let mut conn = fresh();
    apply(&mut conn, &card_payload(&[], &[], Some(r#"{"x":0.0,"y":0.0,"zoom":1.0}"#)));
    assert!(read(&conn).get("viewport").is_some());
    apply(&mut conn, &card_payload(&[], &[], None));
    assert!(read(&conn).get("viewport").is_none());
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
      write_board_tx(
        &tx,
        &card_payload(&[("a", r#"{"id":"a","title":"Kept"}"#)], &["a"], Some(r#"{"x":0.0,"y":0.0,"zoom":1.0}"#)),
      )
      .unwrap();
      tx.commit().unwrap();
      let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    } // the connection drops here — the file is closed

    // A brand-new connection, i.e. the file reopened, sees the committed board.
    let v: serde_json::Value = serde_json::from_str(&read_board_db(&path).unwrap()).unwrap();
    assert_eq!(card_ids(&v), vec!["a"]);
    assert_eq!(v["cards"][0]["title"], "Kept");
    assert!(v.get("viewport").is_some());
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

    let refs = library_media_refs(&dir, None).unwrap();
    let mut unknown = refs.unknown.clone();
    unknown.sort();
    assert_eq!(unknown, vec!["brd_corrupt", "brd_legacy", "brd_old"]);
    let mut names: Vec<_> = refs.names.into_iter().collect();
    names.sort();
    assert_eq!(names, vec!["a.png", "b.pdf", "c.eml"]);

    let except = library_media_refs(&dir, Some("brd_other")).unwrap();
    assert!(!except.names.contains("c.eml"));
    assert!(library_media_refs(&dir.join("absent"), None).is_err());
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
