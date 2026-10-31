//! The board list and the board to reopen, in library.sqlite. Each summary is written
//! by `create_boards` and by each content edit, so listing boards never opens one.
//! Unlike the search index beside it, this is a source of truth, imported once from
//! the `index.json` that held it before.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use super::board_db::valid_board_id;
use crate::library_index::LibraryDb;

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BoardSummary {
  pub(crate) id: String,
  title: String,
  updated_at: String,
}

pub(crate) fn init(conn: &Connection, library: &Path) -> Result<(), String> {
  conn
    .execute_batch(
      "CREATE TABLE IF NOT EXISTS boards (
         id         TEXT PRIMARY KEY,
         title      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS library_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|e| format!("Could not prepare the board list: {e}"))?;
  import_index_json(conn, library)
}

/// The pre-SQLite `index.json`, as TypeScript wrote it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexJson {
  version: u8,
  #[serde(default)]
  current_id: Option<String>,
  #[serde(default)]
  entries: Vec<BoardSummary>,
}

const IMPORTED: &str = "index_json";

/// Import `index.json` once, then rename it `index.json.migrated`. Never deletes it,
/// and never imports twice: the `index_json` row records that it was dealt with, even
/// when there was none or it would not parse. A read error leaves no row, so the next
/// launch tries again.
fn import_index_json(conn: &Connection, library: &Path) -> Result<(), String> {
  if state(conn, IMPORTED)?.is_some() {
    return Ok(());
  }
  let path = library.join("index.json");
  let index = match std::fs::read_to_string(&path) {
    Ok(text) => Some(serde_json::from_str::<IndexJson>(&text).ok().filter(|i| i.version == 1)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
    Err(e) => {
      log::warn!("index.json not imported this launch: {e}");
      return Ok(());
    }
  };
  let tx = conn.unchecked_transaction().map_err(|e| format!("Could not import index.json: {e}"))?;
  let outcome = match index {
    None => "absent",
    Some(None) => "unreadable",
    Some(Some(index)) => {
      for summary in freshest(index.entries) {
        upsert(&tx, &summary)?;
      }
      if let Some(id) = index.current_id.filter(|id| valid_board_id(id)) {
        set_state(&tx, "current_id", Some(&id))?;
      }
      "imported"
    }
  };
  set_state(&tx, IMPORTED, Some(outcome))?;
  tx.commit().map_err(|e| format!("Could not import index.json: {e}"))?;
  if outcome == "imported" {
    if let Err(e) = std::fs::rename(&path, library.join("index.json.migrated")) {
      log::warn!("index.json imported but not renamed: {e}");
    }
  }
  Ok(())
}

/// One summary per usable id, the freshest by `updatedAt`: a library that survived an
/// earlier re-seed can carry a duplicate.
fn freshest(entries: Vec<BoardSummary>) -> Vec<BoardSummary> {
  let mut best: HashMap<String, BoardSummary> = HashMap::new();
  for e in entries.into_iter().filter(|e| valid_board_id(&e.id)) {
    if best.get(&e.id).is_none_or(|prev| e.updated_at > prev.updated_at) {
      best.insert(e.id.clone(), e);
    }
  }
  best.into_values().collect()
}

pub(crate) fn upsert_summary(conn: &Connection, id: &str, title: &str, updated_at: &str) -> Result<(), String> {
  upsert(conn, &BoardSummary { id: id.into(), title: title.into(), updated_at: updated_at.into() })
}

fn upsert(conn: &Connection, s: &BoardSummary) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO boards(id, title, updated_at) VALUES(?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
      params![s.id, s.title, s.updated_at],
    )
    .map(|_| ())
    .map_err(|e| format!("Could not update the board list: {e}"))
}

pub(super) fn remove_summary(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute("DELETE FROM boards WHERE id=?1", [id])
    .map(|_| ())
    .map_err(|e| format!("Could not update the board list: {e}"))
}

pub(crate) fn listed_ids(conn: &Connection) -> Result<Vec<String>, String> {
  Ok(summaries(conn)?.into_iter().map(|s| s.id).collect())
}

/// Newest first, the order the Open dialog lists boards in.
pub(crate) fn summaries(conn: &Connection) -> Result<Vec<BoardSummary>, String> {
  let mut stmt = conn
    .prepare("SELECT id, title, updated_at FROM boards ORDER BY updated_at DESC")
    .map_err(|e| format!("Could not read the board list: {e}"))?;
  stmt
    .query_map([], |r| Ok(BoardSummary { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)? }))
    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
    .map_err(|e| format!("Could not read the board list: {e}"))
}

fn state(conn: &Connection, key: &str) -> Result<Option<String>, String> {
  conn
    .query_row("SELECT value FROM library_state WHERE key=?1", [key], |r| r.get(0))
    .optional()
    .map_err(|e| format!("Could not read the library state: {e}"))
}

fn set_state(conn: &Connection, key: &str, value: Option<&str>) -> Result<(), String> {
  let done = match value {
    Some(v) => conn.execute(
      "INSERT INTO library_state(key, value) VALUES(?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      params![key, v],
    ),
    None => conn.execute("DELETE FROM library_state WHERE key=?1", [key]),
  };
  done.map(|_| ()).map_err(|e| format!("Could not write the library state: {e}"))
}

const LIBRARY_MCP: &str = "library_mcp";

pub(crate) fn library_mcp_enabled(conn: &Connection) -> Result<bool, String> {
  Ok(state(conn, LIBRARY_MCP)?.as_deref() == Some("on"))
}

pub(crate) fn set_library_mcp_enabled(conn: &Connection, on: bool) -> Result<(), String> {
  set_state(conn, LIBRARY_MCP, on.then_some("on"))
}

#[tauri::command(async)]
pub fn list_boards(db: State<LibraryDb>) -> Result<Vec<BoardSummary>, String> {
  summaries(&*db.lock_db()?)
}

#[tauri::command(async)]
pub fn current_board_id(db: State<LibraryDb>) -> Result<Option<String>, String> {
  state(&*db.lock_db()?, "current_id")
}

#[tauri::command(async)]
pub fn set_current_board_id(db: State<LibraryDb>, id: Option<String>) -> Result<(), String> {
  set_state(&*db.lock_db()?, "current_id", id.as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::temp_dir_for;

  fn open(library: &Path) -> Connection {
    let conn = Connection::open(library.join("library.sqlite")).unwrap();
    init(&conn, library).unwrap();
    conn
  }

  fn summary(id: &str, title: &str, updated_at: &str) -> BoardSummary {
    BoardSummary { id: id.into(), title: title.into(), updated_at: updated_at.into() }
  }

  const INDEX: &str = r#"{
    "version": 1,
    "currentId": "brd_a",
    "entries": [
      { "id": "brd_b", "title": "B", "updatedAt": "2025-01-01T00:00:00.000Z" },
      { "id": "brd_a", "title": "A (old)", "updatedAt": "2025-01-01T00:00:00.000Z" },
      { "id": "brd_a", "title": "A", "updatedAt": "2025-01-03T00:00:00.000Z" },
      { "id": "../escape", "title": "X", "updatedAt": "2025-01-04T00:00:00.000Z" }
    ]
  }"#;

  #[test]
  fn imports_index_json_once_and_keeps_it_renamed() {
    let dir = temp_dir_for("index-import");
    std::fs::write(dir.join("index.json"), INDEX).unwrap();
    let conn = open(&dir);
    assert_eq!(
      summaries(&conn).unwrap(),
      vec![summary("brd_a", "A", "2025-01-03T00:00:00.000Z"), summary("brd_b", "B", "2025-01-01T00:00:00.000Z")]
    );
    assert_eq!(state(&conn, "current_id").unwrap().as_deref(), Some("brd_a"));
    assert!(!dir.join("index.json").exists());
    assert_eq!(std::fs::read_to_string(dir.join("index.json.migrated")).unwrap(), INDEX);

    // A later launch, even with an index.json back in place, imports nothing.
    upsert_summary(&conn, "brd_b", "B renamed", "2025-02-01T00:00:00.000Z").unwrap();
    drop(conn);
    std::fs::write(dir.join("index.json"), INDEX).unwrap();
    let conn = open(&dir);
    assert_eq!(summaries(&conn).unwrap()[0], summary("brd_b", "B renamed", "2025-02-01T00:00:00.000Z"));
    assert!(dir.join("index.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_unreadable_index_json_is_left_where_it_is() {
    let dir = temp_dir_for("index-unreadable");
    std::fs::write(dir.join("index.json"), r#"{"version":2,"entries":[]}"#).unwrap();
    let conn = open(&dir);
    assert!(summaries(&conn).unwrap().is_empty());
    assert_eq!(state(&conn, IMPORTED).unwrap().as_deref(), Some("unreadable"));
    assert!(dir.join("index.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn no_index_json_is_an_empty_library() {
    let dir = temp_dir_for("index-absent");
    let conn = open(&dir);
    assert!(summaries(&conn).unwrap().is_empty());
    assert_eq!(state(&conn, "current_id").unwrap(), None);
    set_state(&conn, "current_id", Some("brd_x")).unwrap();
    set_state(&conn, "current_id", None).unwrap();
    assert_eq!(state(&conn, "current_id").unwrap(), None);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_library_mcp_is_off_until_turned_on_and_stays_as_set() {
    let dir = temp_dir_for("index-library-mcp");
    let conn = open(&dir);
    assert!(!library_mcp_enabled(&conn).unwrap());
    set_library_mcp_enabled(&conn, true).unwrap();
    drop(conn);
    let conn = open(&dir);
    assert!(library_mcp_enabled(&conn).unwrap());
    set_library_mcp_enabled(&conn, false).unwrap();
    assert!(!library_mcp_enabled(&conn).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
