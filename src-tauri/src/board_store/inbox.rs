//! Inbox folder.
//!
//! A watched drop-folder, the way in for imports a webview drop can't take (a whole
//! Mail conversation, chiefly, but also screenshots and files dropped into Finder).
//! The shell watches it, hands any settled email/image/document files to the web
//! side (`src/platform/inbox.ts`, which routes email to the import preview and media
//! straight to cards), and moves them aside so nothing imports twice. Each file is
//! content-addressed into the library on import, so the moved-aside copy is only a
//! record of what arrived.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use super::{inbox_dir, run_open};

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
}
