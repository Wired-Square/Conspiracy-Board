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
//!   <app-data>/library.sqlite      the board list (`board_index`) and the search index
//!   <app-data>/boards/<id>.sqlite  the board itself, one SQLite database per board
//!   <app-data>/media/<hash>.<ext>  one imported file, referenced by name
//!
//! A board is a SQLite database (`board_db`); media are plain files (see
//! `write_atomic`).

pub mod board_db;
pub mod board_index;
pub mod bundle;
pub mod inbox;
pub mod media;
pub mod session;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

use wslib_file_atomic::{Options, Readers};

pub(crate) fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
  // Dev builds can point at a throwaway library, so a walk never edits the real one.
  #[cfg(debug_assertions)]
  if let Some(dir) = std::env::var_os("CONSPIRACY_LIBRARY_DIR").filter(|d| !d.is_empty()) {
    return Ok(PathBuf::from(dir));
  }
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

/// Missing is not an error: it is the first run, and the caller seeds from it.
fn read_opt(path: PathBuf) -> Result<Option<String>, String> {
  match std::fs::read_to_string(&path) {
    Ok(s) => Ok(Some(s)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read {}: {e}", path.display())),
  }
}

/// A connection that cannot write, for a reader beside the open session.
pub(crate) fn open_read_only(path: &Path) -> Result<Connection, String> {
  let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
  let failed = |e: rusqlite::Error| format!("Could not open {}: {e}", path.display());
  let conn = Connection::open_with_flags(path, flags).map_err(failed)?;
  conn.busy_timeout(Duration::from_secs(5)).map_err(failed)?;
  Ok(conn)
}

/// How media files are written: staged beside the target as
/// `<name>.new`, synced, then renamed over it, so a crash leaves the old file or the
/// new one. (Boards are SQLite databases with their own transactional write.)
fn atomic_writer() -> Options {
  Options::new().readers(Readers::Readable).create_parents(true)
}

/// The staged name is fixed per target, so two writers to one path would clear each
/// other's staging file; commands run concurrently, so writes take turns.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
  let _turn = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  atomic_writer().write(path, contents).map_err(|e| format!("Save failed: {e}"))
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
#[tauri::command(async)]
pub fn init_storage(app: AppHandle) -> Result<(), String> {
  for dir in [boards_dir(&app)?, media_dir(&app)?, inbox_dir(&app)?] {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
  }
  #[cfg(debug_assertions)]
  if std::env::var_os("CONSPIRACY_LIBRARY_DIR").is_some_and(|d| !d.is_empty()) {
    app.asset_protocol_scope().allow_directory(media_dir(&app)?, true).map_err(|e| e.to_string())?;
  }
  Ok(())
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

#[cfg(test)]
pub(crate) fn temp_dir_for(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("conspiracy-test-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn write_atomic_replaces_whole_and_leaves_no_staging_file() {
    let dir = temp_dir_for("atomic");
    let path = dir.join("nested").join("a.png");
    write_atomic(&path, b"first").unwrap();
    write_atomic(&path, b"second").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second");
    assert!(!atomic_writer().staged_path(&path).exists());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
