//! Where boards and their media live on disk.
//!
//! A webview has nowhere durable to keep them — localStorage is ~5MB, charged in
//! UTF-16, and cards used to inline their images as base64, so one board with a
//! few photographs could fill the whole library's budget. Files have no such
//! ceiling, and imported media (pictures, the original .eml, attachments, a
//! document's file) is kept out of the board JSON entirely, referenced by name.
//!
//! The library lives in the OS-standard per-app data directory, so it is where a
//! Mac (or a Linux box, or Windows) expects an app to keep its files — and out of
//! iCloud's reach, which a Documents folder is not. On macOS that is
//! ~/Library/Application Support/com.wiredsquare.conspiracy:
//!
//!   <app-data>/index.json         { version, currentId, entries: [...] }
//!   <app-data>/boards/<id>.sqlite  the board itself, one SQLite database per board
//!   <app-data>/media/<hash>.<ext>  one imported file, referenced by name
//!
//! A board's cards, connections and clusters are one `(id, json)` row each, so a
//! save writes only the rows that changed rather than rewriting the whole board, and
//! a crash can't tear the file (WAL + one transaction per save). The rule the old
//! single-file store kept still holds: Rust owns the board *envelope* — the five
//! top-level keys, and which id belongs to which table — and TypeScript owns the
//! *card*. The `json` column is a card's bytes, passed through verbatim on the way
//! out (`serde_json`'s `RawValue`) and never parsed here; the schema stays in
//! TypeScript (`src/data/schema.ts`), its one canonical definition. Media, and the
//! index, are still plain files (see `write_atomic`).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

/// A media file younger than this is never swept by `gc_media`: it may have just
/// been written and the board that references it not yet saved.
const GC_MIN_AGE: Duration = Duration::from_secs(60);

/// Whether an id is safe to reach the filesystem as a filename. Ids are generated
/// as `brd_<hex>` (`src/lib/ids.ts`), so this rejects nothing legitimate; it exists
/// because an id arrives as a filename from `index.json` (an ordinary file a user
/// can hand-edit) or a bundle's `boards/<id>.json` entry name — without it, an id of
/// `../../../etc/something` would be honoured. `board_file` and the bundle reader
/// both go through it, so one rule covers every path an id takes to disk.
fn valid_board_id(id: &str) -> bool {
  !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn board_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !valid_board_id(id) {
    return Err(format!("Not a usable board id: {id:?}"));
  }
  Ok(boards_dir(app)?.join(format!("{id}.json")))
}

/// One filesystem-safe name segment with a single short alnum extension — the
/// traversal guard for the media directory, the sibling of `board_file`'s id
/// check. A media name reaches the filesystem the same way a board id does:
/// minted by content hash (`media_name`), or hand-editable in a board file. One
/// segment, no traversal, an extension the OS can open on; a name that fails it
/// never reaches `join`.
fn valid_media_name(name: &str) -> bool {
  !name.is_empty()
    && !name.contains("..")
    && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    && name.matches('.').count() == 1
    && name.rsplit('.').next().is_some_and(|ext| {
      !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

pub(crate) fn media_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
  if !valid_media_name(name) {
    return Err(format!("Not a usable media name: {name:?}"));
  }
  Ok(media_dir(app)?.join(name))
}

pub(crate) fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
  // The OS-standard per-app data directory — on macOS
  // ~/Library/Application Support/com.wiredsquare.conspiracy, and the platform's
  // equivalent elsewhere (XDG data home on Linux, %APPDATA% on Windows). It
  // already carries the bundle identifier as its leaf, so there is no extra
  // "Conspiracy" folder to add.
  app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Nowhere to keep the library: {e}"))
}

fn boards_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(library_dir(app)?.join("boards"))
}

fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(library_dir(app)?.join("media"))
}

/// A drop-folder in the library, opened for the user by *Show Inbox Folder*. Files
/// left here are imported and then moved aside — see `start_inbox_watcher`. It is
/// the way in for the things a
/// webview drop can't take: dragging a whole Mail conversation to it writes one
/// .eml per message (Finder fulfils the promise the page can't), so a thread
/// arrives as files the ordinary email importer already understands.
fn inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(library_dir(app)?.join("Inbox"))
}

fn index_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(library_dir(app)?.join("index.json"))
}

/// Missing is not an error: it is the first run, and the caller seeds from it.
fn read_opt(path: PathBuf) -> Result<Option<String>, String> {
  match std::fs::read_to_string(&path) {
    Ok(s) => Ok(Some(s)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read {}: {e}", path.display())),
  }
}

/// Write via a temporary file in the same directory, then rename. The index and a
/// media file are each written whole, so a crash mid-write would otherwise leave a
/// truncated file; rename is atomic, so the file is either the old one or the new one
/// and never half of each. (Boards no longer come through here — each is a SQLite
/// database with its own transactional write; see `save_board`.)
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
  let dir = path.parent().ok_or("File path has no directory")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;

  let name = path.file_name().ok_or("File path has no name")?.to_string_lossy();
  let tmp = path.with_file_name(format!("{name}.tmp"));
  std::fs::write(&tmp, contents).map_err(|e| format!("Save failed: {e}"))?;
  std::fs::rename(&tmp, path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    format!("Save failed: {e}")
  })
}

/// Content-addressed name: the sha-256 of the bytes in hex, then a safe
/// extension so the OS knows how to open it. Same bytes and extension always
/// produce the same name, so importing a file twice stores it once — and a name
/// can be shared by several cards, which is why media is swept, not deleted the
/// moment one card lets go of it (see `gc_media`).
fn media_name(bytes: &[u8], ext: &str) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let digest = Sha256::digest(bytes);
  let mut name = String::with_capacity(digest.len() * 2 + 1 + 8);
  for b in digest {
    name.push(HEX[(b >> 4) as usize] as char);
    name.push(HEX[(b & 0x0f) as usize] as char);
  }
  name.push('.');
  name.push_str(&safe_ext(ext));
  name
}

/// One short alphanumeric extension, lowercased; `bin` when there is none usable.
fn safe_ext(ext: &str) -> String {
  let e: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
  if e.is_empty() {
    "bin".to_string()
  } else {
    e.to_ascii_lowercase()
  }
}

/// The extension of a media file's name — the text after its single dot, or `bin` if
/// somehow there is none. Re-storing a bundled file (`read_bundle`) and verifying one
/// (`verify_media`) both re-derive the content-address from it, so they must read the
/// extension the same way; sharing this is what keeps them in lockstep.
pub(crate) fn media_ext(name: &str) -> &str {
  name.rsplit_once('.').map(|(_, e)| e).unwrap_or("bin")
}

/// Store bytes under their content hash, writing only when the file is not
/// already there — the name is proof the content is byte-identical, so a second
/// import of the same file is a no-op. Returns the name to link from the board.
/// Shared by `save_media` (webview bytes) and the Apple Mail drop (which already
/// has the .eml bytes in hand, so there is no second write to the webview).
pub(crate) fn store_media_bytes(app: &AppHandle, bytes: &[u8], ext: &str) -> Result<String, String> {
  let name = media_name(bytes, ext);
  let path = media_file(app, &name)?;
  if !path.exists() {
    write_atomic(&path, bytes)?;
  }
  Ok(name)
}

#[tauri::command]
pub fn load_index(app: AppHandle) -> Result<Option<String>, String> {
  read_opt(index_file(&app)?)
}

#[tauri::command]
pub fn save_index(app: AppHandle, json: String) -> Result<(), String> {
  write_atomic(&index_file(&app)?, json.as_bytes())
}

// ---- Per-board SQLite ----
//
// One database per board (boards/<id>.sqlite). The webview hands `save_board` the
// board split into rows — each card/connection/cluster as `{ id, json }`, plus the
// complete ordered id lists and the envelope's small parts — and this side upserts
// the bodies and deletes any row whose id is no longer present, all in one
// transaction. `load_board` reassembles the exact board JSON the schema expects,
// passing each stored fragment through untouched. The extension is `.sqlite`; the
// old `boards/<id>.json` is read once, on first open, and migrated (see the seam in
// src/storage/tauriStorage.ts, which then calls `retire_legacy_board`).

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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
  Ok(())
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

/// Delete a file, treating "already gone" as success — the caller wanted it absent.
fn remove_if_present(path: &Path) -> Result<(), String> {
  match std::fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("Could not delete {}: {e}", path.display())),
  }
}

/// Bring the library up before the first read or write, making its directories so
/// the boards and media folders exist from the start rather than only after the
/// first save.
#[tauri::command]
pub fn init_storage(app: AppHandle) -> Result<(), String> {
  for dir in [boards_dir(&app)?, media_dir(&app)?, inbox_dir(&app)?] {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
  }
  Ok(())
}

/// The absolute media directory, fetched once at startup so the webview can build
/// `asset:` URLs for stored files without a round-trip per render.
#[tauri::command]
pub fn media_dir_path(app: AppHandle) -> Result<String, String> {
  Ok(media_dir(&app)?.to_string_lossy().into_owned())
}

/// Store raw bytes (base64 over the IPC boundary, as a Tauri command is JSON) as
/// an atomic media file, named by content hash, returning the name to link from
/// the board. The caller supplies only the extension; the name is derived from
/// the bytes, so it cannot be steered anywhere but into the media directory.
#[tauri::command]
pub fn save_media(app: AppHandle, ext: String, b64: String) -> Result<String, String> {
  let bytes = STANDARD.decode(b64.as_bytes()).map_err(|e| format!("Media was not valid base64: {e}"))?;
  store_media_bytes(&app, &bytes, &ext)
}

/// A downloaded image, handed back the same way media crosses the boundary: bytes
/// as base64, plus whatever `Content-Type` the server declared so the webview can
/// name the file's extension. The bytes are stored (`save_media`) on this side of
/// the seam by the caller, not here — this only fetches.
#[derive(serde::Serialize)]
pub struct FetchedImage {
  b64: String,
  mime: Option<String>,
}

/// The most bytes we will pull down for one image. A pasted URL is trusted no more
/// than a hand-edited board file, so an accidental link to something enormous
/// cannot make the shell buffer it all.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Fetch a remote image so a pasted URL becomes a local file like any other media.
/// This has to happen in the shell: the app's CSP forbids the webview fetching
/// arbitrary hosts, and a cross-origin image drawn to a canvas to crop would taint
/// it. http(s) only, a short timeout so a dead link never hangs a board load
/// (migrateBoardMedia calls this for every remote URL), and a size cap.
#[tauri::command]
pub fn fetch_image(url: String) -> Result<FetchedImage, String> {
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Err("Only http and https image URLs can be downloaded.".into());
  }
  let agent = ureq::AgentBuilder::new()
    .timeout_connect(Duration::from_secs(10))
    .timeout_read(Duration::from_secs(20))
    .build();
  let resp = agent
    .get(&url)
    .call()
    .map_err(|e| format!("Could not fetch the image: {e}"))?;

  // Only the media type, dropping any `; charset=…`. A server that says it is not
  // an image is refused rather than saved as bytes that will never render.
  let mime = resp
    .header("Content-Type")
    .map(|s| s.split(';').next().unwrap_or(s).trim().to_ascii_lowercase());
  if let Some(m) = &mime {
    if !m.starts_with("image/") {
      return Err("That URL didn't return an image.".into());
    }
  }

  // Size the buffer to the declared length (capped) so a large image needs no
  // repeated grow-and-copy; a missing or lying Content-Length just costs the
  // default growth. Read one byte past the cap so a file exactly on the limit is
  // not mistaken for an over-large one, and reject anything longer.
  let hint = resp
    .header("Content-Length")
    .and_then(|s| s.parse::<u64>().ok())
    .map_or(0, |n| n.min(MAX_IMAGE_BYTES)) as usize;
  let mut bytes = Vec::with_capacity(hint);
  resp
    .into_reader()
    .take(MAX_IMAGE_BYTES + 1)
    .read_to_end(&mut bytes)
    .map_err(|e| format!("Could not read the image: {e}"))?;
  if bytes.len() as u64 > MAX_IMAGE_BYTES {
    return Err("That image is too large to download.".into());
  }

  Ok(FetchedImage { b64: STANDARD.encode(&bytes), mime })
}

/// Read a media file back as base64 — used to re-parse a stored `.eml` for its
/// attachments (`recoverCardAttachments`) and to adopt an orphaned file.
#[tauri::command]
pub fn read_media(app: AppHandle, name: String) -> Result<String, String> {
  let bytes = std::fs::read(media_file(&app, &name)?).map_err(|e| format!("Could not read media: {e}"))?;
  Ok(STANDARD.encode(bytes))
}

/// Metadata pulled out of an imported file, to fill in the card made from it. Every
/// field is optional: a format that doesn't carry one, or a file we cannot parse,
/// simply omits it — extraction is best-effort and never fails the import. Dates are
/// ISO-8601 UTC so the webview can drop them straight onto a card's `occurredAt`.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
  title: Option<String>,
  author: Option<String>,
  created: Option<String>,
  modified: Option<String>,
  pages: Option<u32>,
  words: Option<u32>,
  width: Option<u32>,
  height: Option<u32>,
  taken_at: Option<String>,
  camera_make: Option<String>,
  camera_model: Option<String>,
  latitude: Option<f64>,
  longitude: Option<f64>,
}

/// Read what metadata we can from a stored media file, dispatched by its leading
/// bytes — a PDF's Info dictionary, an Office file's docProps XML, or a photo's
/// dimensions and EXIF. Reads the file by its library name (the `media_file`
/// traversal guard applies), so nothing crosses the boundary but the name and the
/// result. This lives in the shell for the same reasons the download does: the CSP
/// keeps the webview from this work, and these are file-format parsers with no
/// place in a UI bundle.
#[tauri::command]
pub fn extract_media_meta(app: AppHandle, name: String) -> Result<MediaMeta, String> {
  let bytes = std::fs::read(media_file(&app, &name)?).map_err(|e| format!("Could not read media: {e}"))?;
  Ok(if bytes.starts_with(b"%PDF") {
    pdf_meta(&bytes)
  } else if bytes.starts_with(b"PK\x03\x04") {
    ooxml_meta(&bytes)
  } else {
    image_meta(&bytes)
  })
}

/// Recognise the text in a stored image, best-effort — a text-message screenshot's
/// words become the card's notes (see buildMediaDraft). Reads the file by its
/// library name, same traversal guard as extract_media_meta. Empty when there's
/// nothing to read, or on any platform without an OCR engine (only macOS has one).
#[tauri::command]
pub fn ocr_image(app: AppHandle, name: String) -> Result<String, String> {
  let bytes = std::fs::read(media_file(&app, &name)?).map_err(|e| format!("Could not read media: {e}"))?;
  Ok(ocr_bytes(&bytes))
}

#[cfg(target_os = "macos")]
fn ocr_bytes(bytes: &[u8]) -> String {
  crate::ocr::recognise_text(bytes)
}

#[cfg(not(target_os = "macos"))]
fn ocr_bytes(_bytes: &[u8]) -> String {
  String::new()
}

// ---- PDF (lopdf) ----

fn pdf_meta(bytes: &[u8]) -> MediaMeta {
  let mut meta = MediaMeta::default();
  let Ok(doc) = lopdf::Document::load_mem(bytes) else {
    return meta;
  };
  meta.pages = Some(doc.get_pages().len() as u32);
  // The Info dictionary is optional, and any field within it is too.
  if let Ok(info) = doc
    .trailer
    .get(b"Info")
    .and_then(|o| o.as_reference())
    .and_then(|id| doc.get_object(id))
    .and_then(|o| o.as_dict())
  {
    meta.title = pdf_string(info, b"Title");
    meta.author = pdf_string(info, b"Author");
    meta.created = info.get(b"CreationDate").ok().and_then(|o| o.as_str().ok()).and_then(pdf_date);
    meta.modified = info.get(b"ModDate").ok().and_then(|o| o.as_str().ok()).and_then(pdf_date);
  }
  meta
}

fn pdf_string(dict: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
  let s = decode_pdf_text(dict.get(key).ok()?.as_str().ok()?);
  let s = s.trim();
  (!s.is_empty()).then(|| s.to_string())
}

/// A PDF text string is either UTF-16BE (a leading BOM) or PDFDocEncoding, which
/// agrees with Latin-1 across the range names and titles use — enough for this.
fn decode_pdf_text(raw: &[u8]) -> String {
  if raw.starts_with(&[0xFE, 0xFF]) {
    let u16s: Vec<u16> = raw[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&u16s)
  } else {
    raw.iter().map(|&b| b as char).collect()
  }
}

/// A PDF date is `D:YYYYMMDDHHmmSS` with an optional timezone we treat as UTC — a
/// card's date is a day, so the offset does not earn the parsing.
fn pdf_date(raw: &[u8]) -> Option<String> {
  let s = std::str::from_utf8(raw).ok()?;
  let digits: String = s.trim_start_matches("D:").chars().take_while(|c| c.is_ascii_digit()).collect();
  if digits.len() < 8 {
    return None;
  }
  let h = digits.get(8..10).unwrap_or("00");
  let mi = digits.get(10..12).unwrap_or("00");
  let se = digits.get(12..14).unwrap_or("00");
  Some(format!("{}-{}-{}T{h}:{mi}:{se}Z", &digits[0..4], &digits[4..6], &digits[6..8]))
}

// ---- Office / OOXML (zip + quick-xml) ----

fn ooxml_meta(bytes: &[u8]) -> MediaMeta {
  let mut meta = MediaMeta::default();
  let Ok(mut zip) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
    return meta;
  };
  if let Some(core) = read_zip_entry(&mut zip, "docProps/core.xml") {
    for (local, text) in xml_text_by_local(&core) {
      match local.as_str() {
        "title" => set_str(&mut meta.title, text),
        "creator" => set_str(&mut meta.author, text),
        "created" => set_str(&mut meta.created, text),
        "modified" => set_str(&mut meta.modified, text),
        _ => {}
      }
    }
  }
  if let Some(app) = read_zip_entry(&mut zip, "docProps/app.xml") {
    for (local, text) in xml_text_by_local(&app) {
      match local.as_str() {
        "Pages" | "Slides" => meta.pages = meta.pages.or_else(|| text.trim().parse().ok()),
        "Words" => meta.words = text.trim().parse().ok(),
        _ => {}
      }
    }
  }
  meta
}

pub(crate) fn read_zip_entry(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Option<String> {
  let mut f = zip.by_name(name).ok()?;
  let mut s = String::new();
  f.read_to_string(&mut s).ok()?;
  Some(s)
}

/// Every element's local name paired with its (non-empty, trimmed) text. The Office
/// property files are shallow — one value per element — so this flat pass is all the
/// XML they need, no schema knowledge.
fn xml_text_by_local(xml: &str) -> Vec<(String, String)> {
  use quick_xml::events::Event;
  let mut reader = quick_xml::Reader::from_str(xml);
  let mut stack: Vec<String> = Vec::new();
  let mut out: Vec<(String, String)> = Vec::new();
  loop {
    match reader.read_event() {
      Ok(Event::Start(e)) => stack.push(String::from_utf8_lossy(e.name().local_name().as_ref()).into_owned()),
      Ok(Event::End(_)) => {
        stack.pop();
      }
      Ok(Event::Text(t)) => {
        if let (Some(local), Ok(txt)) = (stack.last(), t.unescape()) {
          let s = txt.trim();
          if !s.is_empty() {
            out.push((local.clone(), s.to_string()));
          }
        }
      }
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
  }
  out
}

// First value wins — `xml_text_by_local` has already trimmed and dropped empties.
fn set_str(field: &mut Option<String>, val: String) {
  if field.is_none() {
    *field = Some(val);
  }
}

// ---- Images (imagesize + kamadak-exif) ----

fn image_meta(bytes: &[u8]) -> MediaMeta {
  let mut meta = MediaMeta::default();
  if let Ok(dim) = imagesize::blob_size(bytes) {
    meta.width = Some(dim.width as u32);
    meta.height = Some(dim.height as u32);
  }
  if let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)) {
    meta.taken_at = exif_datetime(&exif);
    meta.camera_make = exif_str(&exif, exif::Tag::Make);
    meta.camera_model = exif_str(&exif, exif::Tag::Model);
    meta.latitude = gps_coord(&exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, 'S');
    meta.longitude = gps_coord(&exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, 'W');
  }
  meta
}

fn exif_str(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
  let f = exif.get_field(tag, exif::In::PRIMARY)?;
  let s = f.display_value().to_string();
  let s = s.trim().trim_matches('"').trim();
  (!s.is_empty()).then(|| s.to_string())
}

/// EXIF `DateTimeOriginal` is `YYYY:MM:DD HH:MM:SS`; we read it as UTC (the optional
/// offset tag is ignored, like the PDF case).
fn exif_datetime(exif: &exif::Exif) -> Option<String> {
  let f = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
  let exif::Value::Ascii(ref lines) = f.value else {
    return None;
  };
  let s = std::str::from_utf8(lines.first()?).ok()?;
  let (date, time) = s.split_once(' ')?;
  let mut d = date.split(':');
  Some(format!("{}-{}-{}T{time}Z", d.next()?, d.next()?, d.next()?))
}

/// A GPS coordinate: three rationals (degrees, minutes, seconds) turned to a signed
/// decimal, negative when the reference is the S or W hemisphere.
fn gps_coord(exif: &exif::Exif, value: exif::Tag, reference: exif::Tag, negative: char) -> Option<f64> {
  let exif::Value::Rational(ref dms) = exif.get_field(value, exif::In::PRIMARY)?.value else {
    return None;
  };
  if dms.len() < 3 {
    return None;
  }
  let decimal = dms[0].to_f64() + dms[1].to_f64() / 60.0 + dms[2].to_f64() / 3600.0;
  let hemisphere = exif.get_field(reference, exif::In::PRIMARY).map(|r| r.display_value().to_string()).unwrap_or_default();
  let sign = if hemisphere.trim_matches('"').starts_with(negative) { -1.0 } else { 1.0 };
  Some(sign * decimal)
}

/// Sweep media no board links any more. Content-addressed files can be shared by
/// several cards or boards, so a file must not be deleted the moment one card
/// drops it: the reference set is only whole once every board has been read.
/// The webview gathers the names still in use and hands them here — anything else
/// in the media directory is unreferenced and removed. Call with a *complete*
/// set: a board that failed to load must keep the whole app from sweeping, or it
/// would cost that board its media. `.tmp` files from an in-flight write are left
/// alone. Returns how many files were removed, for logging.
#[tauri::command]
pub fn gc_media(app: AppHandle, keep: Vec<String>) -> Result<u32, String> {
  let keep: std::collections::HashSet<String> = keep.into_iter().collect();
  let entries = match std::fs::read_dir(media_dir(&app)?) {
    Ok(e) => e,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
    Err(e) => return Err(format!("Could not read the media directory: {e}")),
  };
  let mut removed = 0;
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.ends_with(".tmp") || keep.contains(&name) {
      continue;
    }
    // Leave a very fresh file alone even if it looks unreferenced: it may have
    // just been written and the board that links it not yet saved, so a keep-set
    // built a moment ago would not know about it. The next sweep, once its board
    // is on disk, will keep it or take it for real.
    if entry.metadata().and_then(|m| m.modified()).map_or(true, |t| {
      t.elapsed().map(|age| age < GC_MIN_AGE).unwrap_or(true)
    }) {
      continue;
    }
    if std::fs::remove_file(entry.path()).is_ok() {
      removed += 1;
    }
  }
  Ok(removed)
}

/// One media file on disk, as the maintenance view needs it: the name it is
/// linked by and its size. Read-only — this never deletes.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
  name: String,
  size: u64,
}

/// Every file in the media library, so the webview can show them and work out
/// which are referenced, missing, or orphaned. Purely a listing — unlike
/// `gc_media`, which also reads the directory, this deletes nothing. A missing
/// directory is an empty library, not an error. `*.tmp` in-flight writes are
/// skipped, as in `gc_media`.
#[tauri::command]
pub fn list_media(app: AppHandle) -> Result<Vec<MediaEntry>, String> {
  let entries = match std::fs::read_dir(media_dir(&app)?) {
    Ok(e) => e,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("Could not read the media directory: {e}")),
  };
  let mut out = Vec::new();
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.ends_with(".tmp") {
      continue;
    }
    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
    out.push(MediaEntry { name, size });
  }
  Ok(out)
}

/// Just the names of the media on disk (no sizes), for the search index to reconcile
/// against — its pending set and its prune both compare to exactly what's in `media/`.
/// A missing directory is an empty library; `.tmp` in-flight writes are skipped, as in
/// `list_media`/`gc_media`.
pub(crate) fn media_names(app: &AppHandle) -> Result<Vec<String>, String> {
  let entries = match std::fs::read_dir(media_dir(app)?) {
    Ok(e) => e,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("Could not read the media directory: {e}")),
  };
  let mut out = Vec::new();
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    let name = entry.file_name().to_string_lossy().into_owned();
    if !name.ends_with(".tmp") {
      out.push(name);
    }
  }
  Ok(out)
}

/// Verify a media file still hashes to its own name — the content-address is the
/// integrity check. `true` when the sha-256 of the bytes matches the name's stem,
/// `false` on a mismatch (corruption or tampering); an error only when the file
/// cannot be read. On demand, not eager: re-hashing every file on open would be
/// far too costly for a library of large messages.
#[tauri::command]
pub fn verify_media(app: AppHandle, name: String) -> Result<bool, String> {
  let path = media_file(&app, &name)?;
  let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the file: {e}"))?;
  // The extension is not part of the hash, so re-derive the name from the bytes
  // and the file's own extension and compare whole — the stem is what must match.
  Ok(media_name(&bytes, media_ext(&name)) == name)
}

/// Show the media library folder in Finder — the "these are your files" promise,
/// for the maintenance view. Mirrors `open_inbox`.
#[tauri::command]
pub fn open_media_dir(app: AppHandle) -> Result<(), String> {
  let dir = media_dir(&app)?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Could not find the media folder: {e}"))?;
  run_open(&[dir.as_os_str()], "Could not open the media folder", "The media folder wouldn't open.")
}

/// Shell out to `open`, turning its two failure modes into messages. Every caller
/// that reveals or launches a path goes through here, so the spawn/`success()`
/// check and the wording stay in one place rather than drifting across copies.
fn run_open(args: &[&std::ffi::OsStr], cannot: &str, refused: &str) -> Result<(), String> {
  let launched = std::process::Command::new("open")
    .args(args)
    .status()
    .map_err(|e| format!("{cannot}: {e}"))?
    .success();
  if launched {
    Ok(())
  } else {
    Err(refused.into())
  }
}

/// Open a media file in whatever the OS uses for it — Preview for a PDF, and so
/// on. `open` without `-R`, so it launches the file rather than revealing it.
/// The path is never taken from the caller — only the name is, and `media_file`
/// rejects a name that is not one.
#[tauri::command]
pub fn open_media(app: AppHandle, name: String) -> Result<(), String> {
  let path = media_file(&app, &name)?;
  if !path.exists() {
    return Err("That file isn't in the library.".into());
  }
  run_open(&[path.as_os_str()], "Could not open the file", "The file wouldn't open.")
}

/// Where a board is kept, for telling the user.
///
/// The rest of `src/` is told nothing about where boards live — that is the
/// whole point of the storage seam — but the user is a different question. These
/// are their files, holding their evidence, on their disk. A tool that will not
/// say where it put them is not one to trust with them, and "somewhere in
/// Application Support" is not an answer you can back up.
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
pub fn delete_board(app: AppHandle, id: String) -> Result<(), String> {
  let db = board_db_file(&app, &id)?;
  remove_if_present(&db)?;
  remove_if_present(&db_sidecar(&db, "-wal"))?;
  remove_if_present(&db_sidecar(&db, "-shm"))?;
  remove_if_present(&board_file(&app, &id)?)
}

// ---- Bundles ----
//
// A portable `.zip` of one or more boards plus every media file they reference —
// the way a board (or a whole library) moves to another Mac with all its evidence
// intact, where a single-file JSON export could only carry inlined pictures. The
// shell is a dumb packager here, true to the rest of this module: it never parses
// a board. The webview hands it the board JSON strings, the union of media names,
// and the manifest text it authored; on the way back it is handed the strings to
// parse. The one JSON the shell reads is nothing — it treats even the manifest as
// opaque bytes. Export streams the archive straight to the file the user chose (so
// a large bundle never sits in memory or crosses the IPC boundary); import receives
// the `.zip` as base64 and reads it in memory. The `zip` crate is already a
// dependency, used to read Office metadata. Layout:
//
//   manifest.json          { format, formatVersion, app, exportedAt, boards: [...] }
//   boards/<id>.json        one per board (id is the library id, the filename stem)
//   media/<hash>.<ext>      flat, content-addressed, deduped across boards

/// The largest bundle we will read, as a guard on an untrusted `.zip`: the decoded
/// input, and the running total of what we decompress out of it (a zip bomb inflates
/// far past its stored size, so the stored-size check alone is not enough).
const MAX_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// One board in a bundle: its library id and its JSON, both opaque to the shell.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct BundleBoard {
  id: String,
  json: String,
}

/// What `read_bundle` hands back: the manifest text (absent for a hand-made zip)
/// and every board it carried, for the webview to parse and offer for import.
#[derive(serde::Serialize)]
pub struct BundleContents {
  manifest: Option<String>,
  boards: Vec<BundleBoard>,
}

/// Progress while a bundle's media is stored, emitted as `import:progress` so the
/// webview can show "media <done> of <total>" for a heavy import.
#[derive(Clone, serde::Serialize)]
struct ImportProgress {
  done: u32,
  total: u32,
}

/// A `media/<name>` entry with a valid content-addressed name — the ones
/// `read_bundle` stores, counted up front so progress has a denominator.
fn is_media_entry(name: &str) -> bool {
  name.strip_prefix("media/").map_or(false, valid_media_name)
}

/// Package the given board JSON(s), their media, and a manifest into a `.zip`,
/// written straight to `path` — the file the user chose in the save dialog. The
/// boards and media are the webview's to choose: it parsed the boards to gather the
/// media names, which the shell cannot. Writing to the file (rather than returning
/// base64) keeps the whole archive off the IPC boundary and out of memory. A media
/// file that has gone missing is skipped, not fatal: an export must not fail whole
/// because one referenced file vanished (the same best-effort the old inline export
/// took with an unreadable picture).
#[tauri::command]
pub fn write_bundle(
  app: AppHandle,
  path: String,
  boards: Vec<BundleBoard>,
  media: Vec<String>,
  manifest: String,
) -> Result<(), String> {
  use zip::write::SimpleFileOptions;
  use zip::CompressionMethod;

  let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
  // Media is already compressed (jpg/png/pdf/docx): deflating it again spends CPU
  // for no gain, so it is stored as-is.
  let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

  // The user picked this path through the OS save panel, so it is theirs to write
  // to; the archive is streamed straight into the file rather than buffered whole.
  let out = std::fs::File::create(&path).map_err(|e| format!("Could not create the file: {e}"))?;
  let mut zip = zip::ZipWriter::new(out);

  zip.start_file("manifest.json", deflated).map_err(|e| format!("Could not start the bundle: {e}"))?;
  zip.write_all(manifest.as_bytes()).map_err(|e| format!("Could not write the manifest: {e}"))?;

  for board in &boards {
    if !valid_board_id(&board.id) {
      log::warn!("Skipping a board with an unusable id in export: {:?}", board.id);
      continue;
    }
    zip
      .start_file(format!("boards/{}.json", board.id), deflated)
      .map_err(|e| format!("Could not add a board to the bundle: {e}"))?;
    zip.write_all(board.json.as_bytes()).map_err(|e| format!("Could not write a board: {e}"))?;
  }

  // Dedup here too, so a name repeated across boards is written once even if the
  // caller didn't collapse it.
  let mut written: std::collections::HashSet<&str> = std::collections::HashSet::new();
  for name in &media {
    if !written.insert(name.as_str()) {
      continue;
    }
    let media_path = match media_file(&app, name) {
      Ok(p) => p,
      Err(e) => {
        log::warn!("Skipping an unusable media name in export: {e}");
        continue;
      }
    };
    let mut file = match std::fs::File::open(&media_path) {
      Ok(f) => f,
      // Missing or unreadable: leave it out rather than fail the whole export.
      Err(e) => {
        log::warn!("Skipping media that could not be read for export ({name}): {e}");
        continue;
      }
    };
    zip
      .start_file(format!("media/{name}"), stored)
      .map_err(|e| format!("Could not add media to the bundle: {e}"))?;
    // Stream the file straight into the archive rather than buffering it whole.
    std::io::copy(&mut file, &mut zip).map_err(|e| format!("Could not write media: {e}"))?;
  }

  zip.finish().map_err(|e| format!("Could not finish the bundle: {e}"))?;
  Ok(())
}

/// Read a `.zip` bundle: store every media file it carries into the library and
/// hand the board JSON strings (and the manifest) back for the webview to parse
/// and offer. Media is stored eagerly — content-addressing makes a re-import of an
/// already-present file a no-op, and any media belonging to boards the user then
/// declines is simply orphaned, which the media sweep reclaims. Untrusted input,
/// so every entry name is checked for traversal (`enclosed_name`) and against the
/// same id/media-name guards a hand-edited board file is, and the total decompressed
/// size is capped against a zip bomb.
#[tauri::command]
pub fn read_bundle(app: AppHandle, b64: String) -> Result<BundleContents, String> {
  let bytes = STANDARD.decode(b64.as_bytes()).map_err(|e| format!("Bundle was not valid base64: {e}"))?;
  if bytes.len() as u64 > MAX_BUNDLE_BYTES {
    return Err("That bundle is too large to import.".into());
  }

  let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..]))
    .map_err(|e| format!("That file isn't a readable bundle: {e}"))?;

  let mut manifest: Option<String> = None;
  let mut boards: Vec<BundleBoard> = Vec::new();
  // The decompression budget, shared across every entry, so a bomb of many small
  // entries is caught as surely as one enormous entry.
  let mut budget = MAX_BUNDLE_BYTES;

  // How many media files this bundle will store, for the progress denominator —
  // read from the central directory's names, no decompression. The immutable
  // borrow ends with the statement, before the mutable pass below. `is_media_entry`
  // must stay in step with the media branch of the loop (which re-decides via
  // `enclosed_name`) or `done` would never reach `total`.
  let total_media = zip.file_names().filter(|n| is_media_entry(n)).count() as u32;
  let mut done: u32 = 0;

  for i in 0..zip.len() {
    let mut file = zip.by_index(i).map_err(|e| format!("Could not read the bundle: {e}"))?;
    if !file.is_file() {
      continue;
    }
    // `enclosed_name` is None for anything that could escape the extraction root;
    // such an entry is skipped outright.
    let Some(path) = file.enclosed_name() else {
      continue;
    };
    let mut parts = path.components();
    match (parts.next(), parts.next(), parts.next()) {
      (Some(Component::Normal(a)), None, None) if a == "manifest.json" => {
        manifest = Some(String::from_utf8_lossy(&read_capped(&mut file, &mut budget)?).into_owned());
      }
      (Some(Component::Normal(a)), Some(Component::Normal(name)), None) if a == "boards" => {
        let name = name.to_string_lossy();
        if let Some(stem) = name.strip_suffix(".json") {
          if valid_board_id(stem) {
            let json = String::from_utf8_lossy(&read_capped(&mut file, &mut budget)?).into_owned();
            boards.push(BundleBoard { id: stem.to_string(), json });
          }
        }
      }
      (Some(Component::Normal(a)), Some(Component::Normal(name)), None) if a == "media" => {
        let name = name.to_string_lossy();
        if valid_media_name(&name) {
          let data = read_capped(&mut file, &mut budget)?;
          // store_media_bytes re-derives the content-address, so the stored name
          // equals the bundle name and the board's references still resolve.
          store_media_bytes(&app, &data, media_ext(&name))?;
          done += 1;
          // On a stride, and always the last, rather than every file: a bundle of
          // thousands of media would otherwise flood the IPC bridge with events the
          // "x of y" text can't even tell apart.
          if done % 16 == 0 || done == total_media {
            let _ = app.emit("import:progress", ImportProgress { done, total: total_media });
          }
        }
      }
      // Anything else (an unknown directory, a future addition) is ignored.
      _ => {}
    }
  }

  if boards.is_empty() {
    return Err("This file isn't a Conspiracy bundle.".into());
  }
  Ok(BundleContents { manifest, boards })
}

/// Read a zip entry, drawing down a shared decompression budget so the total pulled
/// out of one bundle can't exceed `MAX_BUNDLE_BYTES` however the archive is shaped.
fn read_capped(reader: &mut impl Read, budget: &mut u64) -> Result<Vec<u8>, String> {
  let mut buf = Vec::new();
  // Read one past the budget so a file exactly on it is not mistaken for over.
  reader
    .take(*budget + 1)
    .read_to_end(&mut buf)
    .map_err(|e| format!("Could not read a bundle entry: {e}"))?;
  if buf.len() as u64 > *budget {
    return Err("That bundle is too large to import.".into());
  }
  *budget -= buf.len() as u64;
  Ok(buf)
}

// ---- Inbox folder ----
//
// A watched drop-folder, the way in for imports a webview drop can't take (a whole
// Mail conversation, chiefly, but also screenshots and files dropped into Finder).
// The shell watches it, hands any settled email/image/document files to the web
// side (`src/platform/inbox.ts`, which routes email to the import preview and media
// straight to cards), and moves them aside so nothing imports twice. Each file is
// content-addressed into the library on import, so the moved-aside copy is only a
// record of what arrived.

/// How often the folder is swept. Slow enough to cost nothing, quick enough that a
/// dropped thread shows up while the user is still looking at the window.
const INBOX_POLL: Duration = Duration::from_millis(1500);

/// One file waiting in the Inbox, on its way to the importer.
#[derive(Clone, serde::Serialize)]
struct InboxFile {
  name: String,
  b64: String,
}

#[derive(Clone, serde::Serialize)]
struct InboxBatch {
  files: Vec<InboxFile>,
}

/// The files the Inbox imports: email that opens the import preview, plus the
/// images and documents the board's own drop target already turns into cards
/// (see `isMediaFile` in `src/lib/import/files.ts`, the canonical extension
/// list this mirrors). Anything else — a stray note — is left in the folder
/// rather than mis-imported.
fn is_inbox_file(name: &str) -> bool {
  let n = name.to_ascii_lowercase();
  const EXT: &[&str] = &[
    ".eml", ".mbox", // email
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".avif",
    ".svg", // images
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", // documents
  ];
  EXT.iter().any(|e| n.ends_with(e))
}

/// A path in `dir` for `name` that doesn't clobber a file already there — two
/// threads with a "Re: …eml" apiece must both be kept.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
  let direct = dir.join(name);
  if !direct.exists() {
    return direct;
  }
  let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
  (1..)
    .map(|i| dir.join(format!("{stem} ({i}).{ext}")))
    .find(|p| !p.exists())
    .unwrap_or(direct)
}

/// Watch the Inbox and hand settled files to the web side to import. A file is
/// taken only once its size has stopped changing, so a message (or a large image)
/// still being written is never read half-formed; taken files move into `.imported`
/// so the next sweep doesn't offer them again.
pub fn start_inbox_watcher(app: AppHandle) {
  std::thread::spawn(move || {
    let Ok(inbox) = inbox_dir(&app) else {
      return;
    };
    let imported = inbox.join(".imported");
    // Last sweep's sizes, so a file is taken only when it stops growing.
    let mut last: HashMap<PathBuf, u64> = HashMap::new();

    loop {
      std::thread::sleep(INBOX_POLL);
      let Ok(entries) = std::fs::read_dir(&inbox) else {
        continue;
      };

      let mut seen: HashMap<PathBuf, u64> = HashMap::new();
      let mut batch: Vec<InboxFile> = Vec::new();
      for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !meta.is_file() || !is_inbox_file(&name) {
          continue;
        }
        let path = entry.path();
        let len = meta.len();
        if len > 0 && last.get(&path) == Some(&len) {
          match std::fs::read(&path) {
            Ok(bytes) => {
              batch.push(InboxFile { name: name.clone(), b64: STANDARD.encode(bytes) });
              // Move it out of the way so it is not offered again. Best-effort:
              // if the move fails, deleting still stops a re-import, and the
              // library kept the .eml on import regardless.
              let _ = std::fs::create_dir_all(&imported);
              let dest = unique_path(&imported, &name);
              let _ = std::fs::rename(&path, &dest).or_else(|_| std::fs::remove_file(&path));
            }
            Err(e) => log::warn!("Could not read Inbox file {name}: {e}"),
          }
        } else {
          seen.insert(path, len);
        }
      }
      last = seen;

      if !batch.is_empty() {
        log::info!("Inbox: importing {} file(s)", batch.len());
        let _ = app.emit("inbox-files", InboxBatch { files: batch });
      }
    }
  });
}

/// Show the Inbox folder in Finder, making it first if need be so the menu item
/// always lands somewhere. Not `-R`: the user wants to open the folder and drop
/// into it, not see it selected in its parent.
pub fn open_inbox(app: &AppHandle) -> Result<(), String> {
  let dir = inbox_dir(app)?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make the Inbox: {e}"))?;
  run_open(&[dir.as_os_str()], "Could not open the Inbox", "The Inbox folder wouldn't open.")
}

#[cfg(test)]
mod tests {
  use super::*;

  // ---- Per-board SQLite ----

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

  fn temp_dir_for(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("conspiracy-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
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
  fn media_name_is_the_content_hash() {
    let a = media_name(b"hello", "png");
    // Same bytes and extension name the same file — that is what dedupes imports.
    assert_eq!(a, media_name(b"hello", "png"));
    // Different bytes, different name.
    assert_ne!(a, media_name(b"world", "png"));
    let (hash, ext) = a.split_once('.').unwrap();
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(ext, "png");
  }

  #[test]
  fn safe_ext_sanitises() {
    assert_eq!(safe_ext("PNG"), "png");
    assert_eq!(safe_ext(""), "bin");
    assert_eq!(safe_ext("verylongextension"), "verylong"); // capped at 8
    assert_eq!(safe_ext("../etc"), "etc"); // separators stripped
  }

  #[test]
  fn is_inbox_file_takes_email_images_and_documents() {
    // Email — the original set.
    assert!(is_inbox_file("thread.eml"));
    assert!(is_inbox_file("Archive.mbox"));
    // Images (a screenshot to OCR) and documents, matched case-insensitively.
    assert!(is_inbox_file("IMG_1234.PNG"));
    assert!(is_inbox_file("chat.jpeg"));
    assert!(is_inbox_file("brief.pdf"));
    assert!(is_inbox_file("Report.DOCX"));
    // A stray note is still left alone.
    assert!(!is_inbox_file("notes.md"));
    assert!(!is_inbox_file("readme"));
  }

  #[test]
  fn valid_media_name_is_the_traversal_guard() {
    assert!(valid_media_name("0123abcd.png"));
    assert!(valid_media_name("a_b-c.eml"));
    assert!(!valid_media_name("../secret.png")); // parent traversal
    assert!(!valid_media_name("a/b.png")); // path separator
    assert!(!valid_media_name("nodot")); // no extension
    assert!(!valid_media_name("two.dots.png")); // more than one dot
    assert!(!valid_media_name("")); // empty
    // A content-addressed name always passes.
    assert!(valid_media_name(&media_name(b"anything", "pdf")));
  }
}
