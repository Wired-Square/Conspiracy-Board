//! Bundles.
//!
//! A portable `.zip` of one or more boards plus every media file they reference —
//! the way a board (or a whole library) moves to another Mac with all its evidence
//! intact, where a single-file JSON export could only carry inlined pictures. The
//! shell is a dumb packager here, true to the rest of the store: it never parses
//! a board. The webview hands it the board JSON strings, the union of media names,
//! and the manifest text it authored; on the way back it is handed the strings to
//! parse. The one JSON the shell reads is nothing — it treats even the manifest as
//! opaque bytes. Export streams the archive straight to the file the user chose (so
//! a large bundle never sits in memory or crosses the IPC boundary); import reads
//! the file the user picked straight from its path. The `zip` crate is already a
//! dependency, used to read Office metadata. Layout:
//!
//!   manifest.json          { format, formatVersion, app, exportedAt, boards: [...] }
//!   boards/<id>.json        one per board (id is the library id, the filename stem)
//!   media/<hash>.<ext>      flat, content-addressed, deduped across boards

use std::io::{Read, Write};
use std::path::Component;
use tauri::{AppHandle, Emitter};

use super::board_db::valid_board_id;
use super::media::{media_ext, media_file, store_media_bytes, valid_media_name};

/// The largest bundle we will read, as a guard on an untrusted `.zip`: the file, and
/// the running total of what we decompress out of it (a zip bomb inflates far past
/// its stored size, so the stored-size check alone is not enough).
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
#[tauri::command(async)]
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
/// size is capped against a zip bomb. A legacy `.json` board is read as a bundle of
/// that one board.
#[tauri::command(async)]
pub fn read_bundle(app: AppHandle, path: String) -> Result<BundleContents, String> {
  // The user picked this path through the OS open panel, so it is theirs to read.
  let mut file = std::fs::File::open(&path).map_err(|e| format!("Could not open the file: {e}"))?;
  if file.metadata().map_or(0, |m| m.len()) > MAX_BUNDLE_BYTES {
    return Err("That bundle is too large to import.".into());
  }
  if path.to_ascii_lowercase().ends_with(".json") {
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| format!("Could not read the file: {e}"))?;
    let json = String::from_utf8_lossy(&bytes).into_owned();
    return Ok(BundleContents { manifest: None, boards: vec![BundleBoard { id: String::new(), json }] });
  }

  let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("That file isn't a readable bundle: {e}"))?;
  // How many media files this bundle will store, for the progress denominator —
  // read from the central directory's names, no decompression. `is_media_entry`
  // must stay in step with the media branch of `unpack_bundle` (which re-decides via
  // `enclosed_name`) or `done` would never reach `total`.
  let total = zip.file_names().filter(|n| is_media_entry(n)).count() as u32;
  let mut done: u32 = 0;
  unpack_bundle(&mut zip, MAX_BUNDLE_BYTES, |name, data| {
    // store_media_bytes re-derives the content-address, so the stored name equals
    // the bundle name and the board's references still resolve.
    store_media_bytes(&app, data, media_ext(name))?;
    done += 1;
    // On a stride, and always the last, rather than every file: a bundle of
    // thousands of media would otherwise flood the IPC bridge with events the
    // "x of y" text can't even tell apart.
    if done % 16 == 0 || done == total {
      let _ = app.emit("import:progress", ImportProgress { done, total });
    }
    Ok(())
  })
}

/// The boards and manifest of an opened bundle, handing each valid media entry to
/// `store_media` by name. `budget` caps the total decompressed, shared across every
/// entry, so a bomb of many small entries is caught as surely as one enormous entry.
fn unpack_bundle<R: Read + std::io::Seek>(
  zip: &mut zip::ZipArchive<R>,
  mut budget: u64,
  mut store_media: impl FnMut(&str, &[u8]) -> Result<(), String>,
) -> Result<BundleContents, String> {
  let mut manifest: Option<String> = None;
  let mut boards: Vec<BundleBoard> = Vec::new();

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
          store_media(&name, &read_capped(&mut file, &mut budget)?)?;
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::media::media_name;

  fn zip_of(entries: &[(&str, &[u8])]) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
      w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
      w.write_all(data).unwrap();
    }
    zip::ZipArchive::new(w.finish().unwrap()).unwrap()
  }

  fn unpack(entries: &[(&str, &[u8])], budget: u64) -> Result<(Vec<String>, Vec<String>), String> {
    let mut stored = Vec::new();
    let contents = unpack_bundle(&mut zip_of(entries), budget, |name, _| {
      stored.push(name.to_string());
      Ok(())
    })?;
    Ok((contents.boards.into_iter().map(|b| b.id).collect(), stored))
  }

  #[test]
  fn unpack_bundle_skips_entries_that_escape_or_misname() {
    let png = media_name(b"x", "png");
    let (boards, media) = unpack(
      &[
        ("boards/brd_ok.json", b"{}"),
        ("../boards/brd_up.json", b"{}"),
        ("boards/../../brd_out.json", b"{}"),
        ("/boards/brd_abs.json", b"{}"),
        ("boards/bad id!.json", b"{}"),
        (&format!("media/{png}"), b"x"),
        (&format!("media/../{png}"), b"x"),
        ("media/../../etc/passwd.png", b"x"),
        ("media/two.dots.png", b"x"),
        ("media/nested/a.png", b"x"),
      ],
      MAX_BUNDLE_BYTES,
    )
    .unwrap();
    assert_eq!(boards, vec!["brd_ok"]);
    assert_eq!(media, vec![png]);
  }

  #[test]
  fn unpack_bundle_caps_the_total_decompressed() {
    let half = [b'a'; 30];
    // Each entry fits the budget alone; together they overrun it.
    assert!(unpack(&[("boards/brd_a.json", &half)], 50).is_ok());
    let err = unpack(&[("boards/brd_a.json", &half), ("boards/brd_b.json", &half)], 50).unwrap_err();
    assert_eq!(err, "That bundle is too large to import.");
  }

  #[test]
  fn unpack_bundle_without_boards_is_not_a_bundle() {
    assert_eq!(unpack(&[("readme.txt", b"hi")], MAX_BUNDLE_BYTES).unwrap_err(), "This file isn't a Conspiracy bundle.");
  }
}
