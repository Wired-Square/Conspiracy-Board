//! Imported media: one content-addressed file per import in `media/`, linked from
//! boards by name.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

use super::board_db::library_media_refs;
use super::board_index::listed_ids;
use super::{boards_dir, media_dir, run_open, write_atomic};
use crate::jobs::Jobs;
use crate::library_index::{prune_documents, LibraryDb};
use crate::extract::meta::{read_meta, MediaMeta};

/// A media file younger than this is never swept by `gc_media`: it may have just
/// been written and the board that references it not yet saved.
const GC_MIN_AGE: Duration = Duration::from_secs(60);

/// One filesystem-safe name segment with a single short alnum extension — the
/// traversal guard for the media directory, the sibling of `board_file`'s id
/// check. A media name reaches the filesystem the same way a board id does:
/// minted by content hash (`media_name`), or hand-editable in a board file. One
/// segment, no traversal, an extension the OS can open on; a name that fails it
/// never reaches `join`.
pub(super) fn valid_media_name(name: &str) -> bool {
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

/// A media file part-way through `write_atomic`, which the sweep and the listings
/// must never see: a valid media name with the staging suffix.
fn is_staged_media(name: &str) -> bool {
  name.strip_suffix(".new").is_some_and(valid_media_name)
}

/// Content-addressed name: the sha-256 of the bytes in hex, then a safe
/// extension so the OS knows how to open it. Same bytes and extension always
/// produce the same name, so importing a file twice stores it once — and a name
/// can be shared by several cards, which is why media is swept, not deleted the
/// moment one card lets go of it (see `gc_media`).
pub(super) fn media_name(bytes: &[u8], ext: &str) -> String {
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
/// import of the same file is a no-op — and queue it for the search index. Returns
/// the name to link from the board.
/// Shared by `save_media` (webview bytes) and the Apple Mail drop (which already
/// has the .eml bytes in hand, so there is no second write to the webview).
pub(crate) fn store_media_bytes(app: &AppHandle, bytes: &[u8], ext: &str) -> Result<String, String> {
  let name = media_name(bytes, ext);
  let path = media_file(app, &name)?;
  if !path.exists() {
    write_atomic(&path, bytes)?;
  }
  if let Some(jobs) = app.try_state::<Arc<Jobs>>() {
    jobs.enqueue([name.clone()], false);
  }
  Ok(name)
}

/// The absolute media directory, fetched once at startup so the webview can build
/// `asset:` URLs for stored files without a round-trip per render.
#[tauri::command(async)]
pub fn media_dir_path(app: AppHandle) -> Result<String, String> {
  Ok(media_dir(&app)?.to_string_lossy().into_owned())
}

/// Store raw bytes (base64 over the IPC boundary, as a Tauri command is JSON) as
/// an atomic media file, named by content hash, returning the name to link from
/// the board. The caller supplies only the extension; the name is derived from
/// the bytes, so it cannot be steered anywhere but into the media directory.
#[tauri::command(async)]
pub fn save_media(app: AppHandle, ext: String, b64: String) -> Result<String, String> {
  let bytes = STANDARD.decode(b64.as_bytes()).map_err(|e| format!("Media was not valid base64: {e}"))?;
  store_media_bytes(&app, &bytes, &ext)
}

/// The most bytes we will pull down for one image. A pasted URL is trusted no more
/// than a hand-edited board file, so an accidental link to something enormous
/// cannot make the shell buffer it all.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Download a remote image into the media library, returning its name to link, so a
/// pasted URL becomes a local file like any other media. This has to happen in the
/// shell: the app's CSP forbids the webview fetching arbitrary hosts, and a
/// cross-origin image drawn to a canvas to crop would taint it.
#[tauri::command(async)]
pub fn download_image(app: AppHandle, url: String) -> Result<String, String> {
  let (bytes, mime) = fetch_image(&url)?;
  store_media_bytes(&app, &bytes, fetched_ext(&url, mime.as_deref()))
}

/// http(s) only, a short timeout so a dead link never hangs a board load
/// (migrateBoardMedia downloads every remote URL), and a size cap. Returns the bytes
/// and the media type the server declared.
fn fetch_image(url: &str) -> Result<(Vec<u8>, Option<String>), String> {
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Err("Only http and https image URLs can be downloaded.".into());
  }
  let agent = ureq::AgentBuilder::new()
    .timeout_connect(Duration::from_secs(10))
    .timeout_read(Duration::from_secs(20))
    .build();
  let resp = agent
    .get(url)
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

  Ok((bytes, mime))
}

/// The extension to store a download under: the server's media type is the authority
/// (`image/svg+xml` is `svg`); the URL's path is the fallback for a host that declared
/// none. `media_name` sanitises whatever this returns.
fn fetched_ext<'a>(url: &'a str, mime: Option<&'a str>) -> &'a str {
  match mime {
    Some(m) => m.split('/').nth(1).and_then(|sub| sub.split('+').next()).unwrap_or(""),
    None => {
      let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
      let before_query = after_scheme.split(['?', '#']).next().unwrap_or("");
      let path = before_query.split_once('/').map_or("", |(_, path)| path);
      let basename = path.rsplit('/').next().unwrap_or("");
      match basename.rfind('.') {
        Some(dot) if dot > 0 => &basename[dot + 1..],
        _ => "",
      }
    }
  }
}

/// Read a media file back as base64 — used to re-parse a stored `.eml` for its
/// attachments (`recoverCardAttachments`) and to adopt an orphaned file.
#[tauri::command(async)]
pub fn read_media(app: AppHandle, name: String) -> Result<String, String> {
  let bytes = std::fs::read(media_file(&app, &name)?).map_err(|e| format!("Could not read media: {e}"))?;
  Ok(STANDARD.encode(bytes))
}

/// Read what metadata we can from a stored media file, dispatched by its leading
/// bytes — a PDF's Info dictionary, an Office file's docProps XML, or a photo's
/// dimensions and EXIF. Reads the file by its library name (the `media_file`
/// traversal guard applies), so nothing crosses the boundary but the name and the
/// result. This lives in the shell for the same reasons the download does: the CSP
/// keeps the webview from this work, and these are file-format parsers with no
/// place in a UI bundle.
#[tauri::command(async)]
pub fn extract_media_meta(app: AppHandle, name: String) -> Result<MediaMeta, String> {
  let bytes = std::fs::read(media_file(&app, &name)?).map_err(|e| format!("Could not read media: {e}"))?;
  Ok(read_meta(&bytes))
}

/// Recognise the text in a stored image, best-effort — a text-message screenshot's
/// words become the card's notes (see buildMediaDraft). Reads the file by its
/// library name, same traversal guard as extract_media_meta. Empty when there's
/// nothing to read, or on any platform without an OCR engine (only macOS has one).
#[tauri::command(async)]
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

/// Sweep media no board links any more. Content-addressed files can be shared by
/// several cards or boards, so a file must not be deleted the moment one card drops
/// it: the keep-set is only whole once every board's refs are known. If any board's
/// are not (`library_media_refs`), nothing is swept and those boards are returned, so
/// the webview can record their refs and ask again. After a sweep the search index
/// drops the rows of whatever went.
#[tauri::command(async)]
pub fn gc_media(app: AppHandle, db: State<LibraryDb>) -> Result<GcOutcome, String> {
  let listed = listed_ids(&*db.lock_db()?)?;
  let outcome = gc(&boards_dir(&app)?, &listed, &media_dir(&app)?, GC_MIN_AGE)?;
  if outcome.unknown.is_empty() {
    prune_documents(&app, &db)?;
  }
  Ok(outcome)
}

fn gc(boards: &Path, listed: &[String], media: &Path, min_age: Duration) -> Result<GcOutcome, String> {
  let refs = library_media_refs(boards, listed, None)?;
  if !refs.unknown.is_empty() {
    return Ok(GcOutcome { removed: 0, unknown: refs.unknown });
  }
  Ok(GcOutcome { removed: sweep(media, &refs.names, min_age)?, unknown: Vec::new() })
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GcOutcome {
  removed: u32,
  unknown: Vec<String>,
}

fn sweep(dir: &Path, keep: &HashSet<String>, min_age: Duration) -> Result<u32, String> {
  let mut removed = 0;
  for (name, entry) in media_entries(dir)? {
    if keep.contains(&name) {
      continue;
    }
    // Leave a very fresh file alone even if it looks unreferenced: it may have
    // just been written and the board that links it not yet saved.
    let fresh = entry
      .metadata()
      .and_then(|m| m.modified())
      .map_or(true, |t| t.elapsed().map_or(true, |age| age < min_age));
    if !fresh && std::fs::remove_file(entry.path()).is_ok() {
      removed += 1;
    }
  }
  Ok(removed)
}

/// Every file in the media directory with its name, leaving out writes in flight
/// (`is_staged_media`). A missing directory is an empty library, not an error.
fn media_entries(dir: &Path) -> Result<Vec<(String, std::fs::DirEntry)>, String> {
  let entries = match std::fs::read_dir(dir) {
    Ok(e) => e,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("Could not read the media directory: {e}")),
  };
  Ok(
    entries
      .flatten()
      .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
      .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry))
      .filter(|(name, _)| !is_staged_media(name))
      .collect(),
  )
}

/// One media file on disk, as the maintenance view needs it: the name it is
/// linked by and its size. Read-only — this never deletes.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
  name: String,
  #[cfg_attr(test, ts(type = "number"))]
  size: u64,
}

/// Every file in the media library, so the webview can show them and work out
/// which are referenced, missing, or orphaned. Purely a listing — unlike
/// `gc_media`, which also reads the directory, this deletes nothing.
#[tauri::command(async)]
pub fn list_media(app: AppHandle) -> Result<Vec<MediaEntry>, String> {
  Ok(
    media_entries(&media_dir(&app)?)?
      .into_iter()
      .map(|(name, entry)| MediaEntry { name, size: entry.metadata().map_or(0, |m| m.len()) })
      .collect(),
  )
}

/// Just the names of the media on disk (no sizes), for the search index to reconcile
/// against — its pending set and its prune both compare to exactly what's in `media/`.
pub(crate) fn media_names(app: &AppHandle) -> Result<Vec<String>, String> {
  Ok(media_entries(&media_dir(app)?)?.into_iter().map(|(name, _)| name).collect())
}

/// Verify a media file still hashes to its own name — the content-address is the
/// integrity check. `true` when the sha-256 of the bytes matches the name's stem,
/// `false` on a mismatch (corruption or tampering); an error only when the file
/// cannot be read. On demand, not eager: re-hashing every file on open would be
/// far too costly for a library of large messages.
#[tauri::command(async)]
pub fn verify_media(app: AppHandle, name: String) -> Result<bool, String> {
  let path = media_file(&app, &name)?;
  let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the file: {e}"))?;
  // The extension is not part of the hash, so re-derive the name from the bytes
  // and the file's own extension and compare whole — the stem is what must match.
  Ok(media_name(&bytes, media_ext(&name)) == name)
}

/// Show the media library folder in Finder — the "these are your files" promise,
/// for the maintenance view. Mirrors `open_inbox`.
#[tauri::command(async)]
pub fn open_media_dir(app: AppHandle) -> Result<(), String> {
  let dir = media_dir(&app)?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("Could not find the media folder: {e}"))?;
  run_open(&[dir.as_os_str()], "Could not open the media folder", "The media folder wouldn't open.")
}

/// Open a media file in whatever the OS uses for it — Preview for a PDF, and so
/// on. `open` without `-R`, so it launches the file rather than revealing it.
/// The path is never taken from the caller — only the name is, and `media_file`
/// rejects a name that is not one.
#[tauri::command(async)]
pub fn open_media(app: AppHandle, name: String) -> Result<(), String> {
  let path = media_file(&app, &name)?;
  if !path.exists() {
    return Err("That file isn't in the library.".into());
  }
  run_open(&[path.as_os_str()], "Could not open the file", "The file wouldn't open.")
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::board_store::board_db::save_board_file;
  use crate::board_store::{atomic_writer, temp_dir_for};

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

  /// The sweep deletes whatever it lists that no board keeps, so a media file that
  /// `write_atomic` has staged but not yet renamed must never be listed — pinned
  /// against the crate's own staging name, so a change there fails here.
  #[test]
  fn media_listing_skips_a_staged_write() {
    let dir = temp_dir_for("staged");
    let name = media_name(b"photo", "png");
    std::fs::write(dir.join(&name), b"photo").unwrap();
    let staged = atomic_writer().staged_path(&dir.join(media_name(b"in flight", "png")));
    std::fs::write(&staged, b"in flight").unwrap();
    std::fs::create_dir(dir.join("not-a-file")).unwrap();

    let listed: Vec<String> = media_entries(&dir).unwrap().into_iter().map(|(n, _)| n).collect();
    assert_eq!(listed, vec![name]);
    assert!(media_entries(&dir.join("absent")).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn fetched_ext_prefers_the_media_type_then_the_url_path() {
    assert_eq!(fetched_ext("https://x.test/a.jpg", Some("image/png")), "png");
    assert_eq!(fetched_ext("https://x.test/a", Some("image/svg+xml")), "svg");
    assert_eq!(fetched_ext("https://x.test/dir/pic.webp?w=200#top", None), "webp");
    assert_eq!(fetched_ext("https://x.test", None), "");
    assert_eq!(fetched_ext("https://x.test/.hidden", None), "");
  }

  /// A temp library holding one media file per name, all old enough to sweep unless
  /// `fresh` names them.
  fn library(name: &str, files: &[&str], fresh: &[&str]) -> (PathBuf, PathBuf, PathBuf) {
    let dir = temp_dir_for(name);
    let (boards, media) = (dir.join("boards"), dir.join("media"));
    std::fs::create_dir_all(&boards).unwrap();
    std::fs::create_dir_all(&media).unwrap();
    for f in files {
      std::fs::write(media.join(f), b"").unwrap();
      if !fresh.contains(f) {
        set_old(&media.join(f));
      }
    }
    (dir, boards, media)
  }

  fn on_disk(media: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(media)
      .unwrap()
      .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    names.sort();
    names
  }

  #[test]
  fn gc_sweeps_only_old_unreferenced_media() {
    let (dir, boards, media) = library("gc-sweep", &["kept.png", "orphan.pdf", "fresh.eml"], &["fresh.eml"]);
    let staged = atomic_writer().staged_path(&media.join("staged.png"));
    std::fs::write(&staged, b"in flight").unwrap();
    set_old(&staged);
    save_board_file(&boards.join("brd_a.sqlite"), Some(&["kept.png"]));

    let outcome = gc(&boards, &["brd_a".into()], &media, GC_MIN_AGE).unwrap();
    assert_eq!(outcome, GcOutcome { removed: 1, unknown: vec![] });
    assert_eq!(on_disk(&media), vec!["fresh.eml", "kept.png", "staged.png.new"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn gc_sweeps_nothing_while_any_board_is_unknown() {
    let (dir, boards, media) = library("gc-unknown", &["kept.png", "orphan.pdf"], &[]);
    save_board_file(&boards.join("brd_a.sqlite"), Some(&["kept.png"]));
    save_board_file(&boards.join("brd_old.sqlite"), None);
    std::fs::write(boards.join("brd_legacy.json"), "{}").unwrap();

    let mut outcome = gc(&boards, &[], &media, GC_MIN_AGE).unwrap();
    outcome.unknown.sort();
    assert_eq!(outcome, GcOutcome { removed: 0, unknown: vec!["brd_legacy".into(), "brd_old".into()] });
    assert_eq!(on_disk(&media), vec!["kept.png", "orphan.pdf"]);
    assert!(gc(&dir.join("absent"), &[], &media, GC_MIN_AGE).is_err());
    assert_eq!(on_disk(&media), vec!["kept.png", "orphan.pdf"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  fn set_old(path: &Path) {
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(old).unwrap();
  }
}
