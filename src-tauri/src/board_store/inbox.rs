//! Inbox folder.
//!
//! A watched drop-folder, the way in for imports a webview drop can't take (a whole
//! Mail conversation, chiefly, but also screenshots and files dropped into Finder).
//! The shell watches it, parses settled email itself and hands the drafts, with any
//! images and documents, to the web side (`src/platform/inbox.ts`, which opens the
//! import preview and turns media into cards), and moves the files aside so nothing
//! imports twice. Each file is
//! content-addressed into the library on import, so the moved-aside copy is only a
//! record of what arrived.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::media::media_store;
use super::{inbox_dir, run_open};
use crate::file_types::{is_importable, kind_of, FileKind};
use crate::import::{app_media_draft, MediaDraft};
use crate::mail::{self, EmailParse};

/// How often the folder is swept. Slow enough to cost nothing, quick enough that a
/// dropped thread shows up while the user is still looking at the window.
const INBOX_POLL: Duration = Duration::from_millis(1500);

/// What one sweep found, every file already stored: the cards its images and
/// documents make, and its email parsed, with how many files that came from (a
/// thread of several is grouped).
#[derive(Clone, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct InboxBatch {
  cards: Vec<MediaDraft>,
  emails: EmailParse,
  email_files: usize,
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
      let mut batch = InboxBatch::default();
      for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !meta.is_file() || !is_importable(&name) {
          continue;
        }
        let path = entry.path();
        let len = meta.len();
        if len > 0 && last.get(&path) == Some(&len) {
          match std::fs::read(&path) {
            Ok(bytes) => {
              if kind_of(&name) == Some(FileKind::Email) {
                let parsed = mail::parse_file(&name, &bytes, &mut media_store(&app), &mut |_, _| {});
                batch.emails.drafts.extend(parsed.drafts);
                batch.emails.errors.extend(parsed.errors);
                batch.email_files += 1;
              } else {
                batch.cards.extend(app_media_draft(&app, &name, &bytes));
              }
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

      if !batch.cards.is_empty() || batch.email_files > 0 {
        log::info!("Inbox: importing {} card(s) and {} email file(s)", batch.cards.len(), batch.email_files);
        let _ = app.emit("inbox-files", batch);
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
