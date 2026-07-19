//! The library-wide search index (library.sqlite).
//!
//! One row per content-addressed media file, plus its full text in an FTS5 table —
//! so a search can find a card by words buried in the PDF or screenshot it carries,
//! not just the fields typed onto it. Keyed by the media name (the content hash), so
//! extraction is deduped across every board and re-running it is idempotent.
//!
//! It is a *derived index*, never a source of truth: the media files and the
//! extractors are authoritative, and this can be dropped and rebuilt from them at any
//! time (`rebuild_index`, then re-pump `pending_media`). It is board-agnostic — it
//! knows media names and text, never a board id or a card field — which is what keeps
//! the shell free of the card schema and cross-board search a later no-op. The webview
//! orchestrates: a background worker asks `pending_media` what still needs reading and
//! calls `process_media` per file (see src/store/jobQueueStore.ts).

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use tauri::{AppHandle, State};

use crate::board_store::{media_ext, media_file, media_names, library_dir};
use crate::extract::{extract_text, ExtractOutcome};

/// The extractors and their versions. Bump it when an extractor changes (a better OCR
/// engine, say) and `pending_media` re-enqueues every file indexed under an older
/// string, so the whole library re-reads on the next launch.
const ENGINE: &str = "pdf:lopdf-0.34;ooxml;ocr:vision-1;plain;v1";

/// How many times a file that keeps failing is retried automatically before it is left
/// alone. A manual reindex (force) always tries again regardless.
const MAX_ATTEMPTS: i64 = 3;

/// The one connection to library.sqlite, behind a mutex. Extraction runs *before* the
/// lock is taken, so files read in parallel on the command threads and only the short
/// writes serialise; WAL keeps a search responsive meanwhile.
pub struct LibraryDb(pub Mutex<Connection>);

/// Open (creating if absent) library.sqlite with its tables. Called once at setup.
pub fn open(app: &AppHandle) -> Result<LibraryDb, String> {
  let dir = library_dir(app)?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the library: {e}"))?;
  let conn = Connection::open(dir.join("library.sqlite"))
    .map_err(|e| format!("Could not open the search index: {e}"))?;
  conn
    .execute_batch(
      "PRAGMA journal_mode=WAL;
       PRAGMA synchronous=NORMAL;
       PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| format!("Could not prepare the search index: {e}"))?;
  init_schema(&conn)?;
  Ok(LibraryDb(Mutex::new(conn)))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      "CREATE TABLE IF NOT EXISTS documents (
         name         TEXT PRIMARY KEY,
         mime         TEXT,
         size         INTEGER NOT NULL,
         status       TEXT NOT NULL,       -- 'indexed' | 'failed' | 'unsupported'
         engine       TEXT,
         extracted_at TEXT,
         error        TEXT,
         attempts     INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS documents_status ON documents(status);
       CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
         name UNINDEXED, body, tokenize='unicode61 remove_diacritics 2'
       );
       PRAGMA user_version=1;",
    )
    .map_err(|e| format!("Could not prepare the search schema: {e}"))
}

/// The status of one file after `process_media`, handed back to the worker.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStatus {
  name: String,
  status: String,
}

/// One search hit: the media name (which the webview maps back to a card), a snippet
/// with the match marked, and its BM25 rank (smaller is better).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocHit {
  name: String,
  snippet: String,
  rank: f64,
}

/// Read a file's text and index it. Idempotent: an unchanged file already indexed
/// under the current engine is a no-op unless `force`. Extraction happens outside the
/// lock; the two writes (documents + doc_fts) commit together so they can't drift.
#[tauri::command]
pub fn process_media(app: AppHandle, db: State<LibraryDb>, name: String, force: bool) -> Result<DocStatus, String> {
  let path = media_file(&app, &name)?; // guards the name against traversal
  let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

  if !force {
    let conn = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
    let existing: Option<(String, Option<String>, i64)> = conn
      .query_row("SELECT status, engine, size FROM documents WHERE name=?1", [&name], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
      })
      .optional()
      .map_err(|e| format!("Could not read the index: {e}"))?;
    if let Some((status, engine, prev_size)) = existing {
      let current = engine.as_deref() == Some(ENGINE);
      // Already settled with this engine, on the same bytes: nothing to do.
      if current && (status == "indexed" || status == "unsupported") && prev_size as u64 == size {
        return Ok(DocStatus { name, status });
      }
    }
  }

  let bytes = std::fs::read(&path).map_err(|e| format!("Could not read media: {e}"))?;
  let outcome = extract_text(&bytes, media_ext(&name));

  let mut guard = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  let tx = guard.transaction().map_err(|e| format!("Could not write the index: {e}"))?;
  let status = write_outcome(&tx, &name, size, &outcome)?;
  tx.commit().map_err(|e| format!("Could not write the index: {e}"))?;
  Ok(DocStatus { name, status })
}

/// Upsert the document row and replace its full-text row, in one transaction. Returns
/// the terminal status recorded.
fn write_outcome(tx: &Transaction, name: &str, size: u64, outcome: &ExtractOutcome) -> Result<String, String> {
  let (status, error): (&str, Option<&str>) = match outcome {
    ExtractOutcome::Text(_) => ("indexed", None),
    ExtractOutcome::Unsupported => ("unsupported", None),
    ExtractOutcome::Failed(e) => ("failed", Some(e.as_str())),
  };
  // The `mime` column is left for a later use (a search UI grouping by type); nothing
  // reads it today, so it isn't written — the extractors dispatch on magic bytes, not
  // a stored mime.
  tx.execute(
    "INSERT INTO documents(name, size, status, engine, extracted_at, error, attempts)
       VALUES(?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?5,
              CASE WHEN ?3='failed' THEN 1 ELSE 0 END)
     ON CONFLICT(name) DO UPDATE SET
       size=excluded.size, status=excluded.status, engine=excluded.engine,
       extracted_at=excluded.extracted_at, error=excluded.error,
       attempts=CASE WHEN excluded.status='failed' THEN documents.attempts + 1 ELSE 0 END",
    params![name, size as i64, status, ENGINE, error],
  )
  .map_err(|e| format!("Could not record the document: {e}"))?;

  tx.execute("DELETE FROM doc_fts WHERE name=?1", [name])
    .map_err(|e| format!("Could not clear old index text: {e}"))?;
  if let ExtractOutcome::Text(body) = outcome {
    tx.execute("INSERT INTO doc_fts(name, body) VALUES(?1, ?2)", params![name, body])
      .map_err(|e| format!("Could not index the text: {e}"))?;
  }
  Ok(status.to_string())
}

// `(async)` runs this on a worker thread rather than the webview's main thread: a broad
// prefix match can take seconds (bm25 ranks every term the prefix expands to), and a plain
// sync command would block the UI — freezing the search box mid-type — for that whole time.
// The body stays synchronous; it only borrows the Mutex guard, never holding it across a wait.
#[tauri::command(async)]
pub fn search_documents(db: State<LibraryDb>, query: String, limit: u32) -> Result<Vec<DocHit>, String> {
  let conn = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  run_search(&conn, &query, limit)
}

fn run_search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<DocHit>, String> {
  let match_query = fts_query(query);
  if match_query.is_empty() {
    return Ok(Vec::new());
  }
  let mut stmt = conn
    .prepare(
      "SELECT name,
              snippet(doc_fts, 1, '<mark>', '</mark>', '…', 12) AS snip,
              bm25(doc_fts) AS rank
         FROM doc_fts WHERE doc_fts MATCH ?1 ORDER BY rank LIMIT ?2",
    )
    .map_err(|e| format!("Could not prepare the search: {e}"))?;
  stmt
    .query_map(params![match_query, limit], |r| {
      Ok(DocHit { name: r.get(0)?, snippet: r.get(1)?, rank: r.get(2)? })
    })
    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
    .map_err(|e| format!("Could not run the search: {e}"))
}

/// Turn a user's text into an FTS5 MATCH string: each whitespace token quoted (so
/// `-`, `:` and the like are literals, not operators) and given a `*` for prefix
/// matching, joined by spaces for implicit AND. Empty when the query has no tokens.
fn fts_query(raw: &str) -> String {
  raw
    .split_whitespace()
    .map(|tok| format!("\"{}\"*", tok.replace('"', "\"\"")))
    .collect::<Vec<_>>()
    .join(" ")
}

/// The files still needing extraction: everything on disk with no row, or a
/// non-terminal row, or one indexed under an older engine, or a failure not yet at its
/// retry cap. The worker asks for this at startup, so a crash mid-batch just resumes.
#[tauri::command]
pub fn pending_media(app: AppHandle, db: State<LibraryDb>) -> Result<Vec<String>, String> {
  let on_disk = media_names(&app)?;
  let conn = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  let mut stmt = conn
    .prepare("SELECT status, engine, attempts FROM documents WHERE name=?1")
    .map_err(|e| format!("Could not read the index: {e}"))?;
  let mut out = Vec::new();
  for name in on_disk {
    let row: Option<(String, Option<String>, i64)> = stmt
      .query_row([&name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
      .optional()
      .map_err(|e| format!("Could not read the index: {e}"))?;
    let pending = match row {
      None => true,
      Some((status, engine, attempts)) => {
        let current = engine.as_deref() == Some(ENGINE);
        match status.as_str() {
          "indexed" | "unsupported" => !current,
          "failed" => !current || attempts < MAX_ATTEMPTS,
          _ => true,
        }
      }
    };
    if pending {
      out.push(name);
    }
  }
  Ok(out)
}

/// Drop the rows for any media the library no longer holds — called after `gc_media`
/// sweeps blobs. Reconciles against what's on disk, not against boards, so it stays
/// board-agnostic like the rest of the index.
#[tauri::command]
pub fn prune_documents(app: AppHandle, db: State<LibraryDb>) -> Result<u32, String> {
  let keep: std::collections::HashSet<String> = media_names(&app)?.into_iter().collect();
  let mut guard = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  let tx = guard.transaction().map_err(|e| format!("Could not prune the index: {e}"))?;
  let names: Vec<String> = {
    let mut stmt = tx.prepare("SELECT name FROM documents").map_err(|e| format!("Could not read the index: {e}"))?;
    let names = stmt
      .query_map([], |r| r.get::<_, String>(0))
      .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
      .map_err(|e| format!("Could not read the index: {e}"))?;
    names
  };
  let mut removed = 0u32;
  {
    let mut del_doc = tx.prepare("DELETE FROM documents WHERE name=?1").map_err(|e| format!("Could not prune: {e}"))?;
    let mut del_fts = tx.prepare("DELETE FROM doc_fts WHERE name=?1").map_err(|e| format!("Could not prune: {e}"))?;
    for name in &names {
      if !keep.contains(name) {
        del_doc.execute([name]).map_err(|e| format!("Could not prune a document: {e}"))?;
        del_fts.execute([name]).map_err(|e| format!("Could not prune index text: {e}"))?;
        removed += 1;
      }
    }
  }
  tx.commit().map_err(|e| format!("Could not prune the index: {e}"))?;
  Ok(removed)
}

/// Empty the index — the recovery path if it ever drifts. The worker then re-pumps
/// `pending_media` (now the whole library) to rebuild it from `media/`.
#[tauri::command]
pub fn rebuild_index(db: State<LibraryDb>) -> Result<(), String> {
  let conn = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  conn
    .execute_batch("DELETE FROM documents; DELETE FROM doc_fts;")
    .map_err(|e| format!("Could not clear the index: {e}"))
}

/// Every document's name and status, for the Objects view to badge each file. Absent
/// from this list means never processed (shown as pending until the worker reaches it).
#[tauri::command]
pub fn index_statuses(db: State<LibraryDb>) -> Result<Vec<DocStatus>, String> {
  let conn = db.0.lock().map_err(|_| "The search index is unavailable.".to_string())?;
  let mut stmt = conn
    .prepare("SELECT name, status FROM documents")
    .map_err(|e| format!("Could not read the index: {e}"))?;
  stmt
    .query_map([], |r| Ok(DocStatus { name: r.get(0)?, status: r.get(1)? }))
    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
    .map_err(|e| format!("Could not read the index: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn
  }

  fn index(conn: &mut Connection, name: &str, outcome: ExtractOutcome) -> String {
    let tx = conn.transaction().unwrap();
    let status = write_outcome(&tx, name, 10, &outcome).unwrap();
    tx.commit().unwrap();
    status
  }

  #[test]
  fn indexes_and_finds_body_text() {
    let mut conn = mem();
    index(&mut conn, "aa.pdf", ExtractOutcome::Text("the quarterly report mentions Acme".into()));
    let hits = run_search(&conn, "quarterly", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "aa.pdf");
    assert!(hits[0].snippet.contains("<mark>"));
    // A word that isn't there finds nothing.
    assert!(run_search(&conn, "zzzzz", 10).unwrap().is_empty());
  }

  #[test]
  fn prefix_and_multi_token_and_is_matched() {
    let mut conn = mem();
    index(&mut conn, "bb.txt", ExtractOutcome::Text("invoice number 2021 from Acme Corp".into()));
    assert_eq!(run_search(&conn, "invo", 10).unwrap().len(), 1); // prefix
    assert_eq!(run_search(&conn, "acme 2021", 10).unwrap().len(), 1); // AND, both present
    assert!(run_search(&conn, "acme 9999", 10).unwrap().is_empty()); // AND, one absent
  }

  #[test]
  fn a_failed_extract_records_the_error_and_no_text() {
    let mut conn = mem();
    let status = index(&mut conn, "cc.pdf", ExtractOutcome::Failed("broken".into()));
    assert_eq!(status, "failed");
    // Nothing indexed, so nothing to find; the row still exists for the badge.
    assert!(run_search(&conn, "broken", 10).unwrap().is_empty());
    let n: i64 = conn.query_row("SELECT count(*) FROM documents WHERE status='failed'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
  }

  #[test]
  fn reindexing_replaces_the_old_text() {
    let mut conn = mem();
    index(&mut conn, "dd.txt", ExtractOutcome::Text("first words".into()));
    index(&mut conn, "dd.txt", ExtractOutcome::Text("second words".into()));
    assert!(run_search(&conn, "first", 10).unwrap().is_empty());
    assert_eq!(run_search(&conn, "second", 10).unwrap().len(), 1);
    // Still one row and one fts entry, not two.
    let docs: i64 = conn.query_row("SELECT count(*) FROM documents", [], |r| r.get(0)).unwrap();
    let fts: i64 = conn.query_row("SELECT count(*) FROM doc_fts", [], |r| r.get(0)).unwrap();
    assert_eq!((docs, fts), (1, 1));
  }

  #[test]
  fn an_empty_query_matches_nothing() {
    assert_eq!(fts_query("   "), "");
    let conn = mem();
    assert!(run_search(&conn, "  ", 10).unwrap().is_empty());
  }
}
