//! A picture or a document turned into the card made from it: stored (which queues it
//! for the search index), its metadata read, and a picture's words recognised so a
//! text-message screenshot carries the conversation.

use std::path::Path;

use tauri::AppHandle;

use crate::board_store::media::{media_store, ocr_bytes, read_media, store_media_bytes, Store};
use crate::extract::meta::{read_meta, MediaMeta};
use crate::file_types::{document_mime, ext_of, file_name, kind_of, FileKind};
use crate::schema::{CardKind, DocumentMeta, ImageMeta, UtcInstant};

/// The fields of the card a file becomes, for the webview to place.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaDraft {
  pub kind: CardKind,
  pub title: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notes: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub image_file: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub image_meta: Option<ImageMeta>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub occurred_at: Option<UtcInstant>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub document: Option<DocumentMeta>,
}

/// Recognised text is kept only when it looks like captured writing: a photo's
/// stray word off a sign is noise in a card's notes.
const MIN_OCR_WORDS: usize = 3;
const MIN_OCR_CHARS: usize = 12;
const TITLE_MAX: usize = 60;

fn usable_ocr(text: &str) -> bool {
  text.chars().filter(|c| !c.is_whitespace()).count() >= MIN_OCR_CHARS
    && text.split_whitespace().count() >= MIN_OCR_WORDS
}

/// The first non-empty line, capped: a screenshot titled by its opening message
/// reads far better than IMG_1234.
fn ocr_title(text: &str) -> String {
  let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
  if first.chars().count() > TITLE_MAX {
    format!("{}…", first.chars().take(TITLE_MAX - 1).collect::<String>().trim_end())
  } else {
    first.to_string()
  }
}

/// A filename without its directory or extension.
fn base_name(name: &str) -> &str {
  let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
  base.rfind('.').filter(|&dot| dot > 0).map_or(base, |dot| &base[..dot])
}

fn image_meta(m: &MediaMeta) -> Option<ImageMeta> {
  let meta = ImageMeta {
    width: m.width.map(f64::from),
    height: m.height.map(f64::from),
    taken_at: m.taken_at.clone(),
    camera_make: m.camera_make.clone(),
    camera_model: m.camera_model.clone(),
    latitude: m.latitude,
    longitude: m.longitude,
  };
  (meta != ImageMeta::default()).then_some(meta)
}

fn document_props(m: &MediaMeta) -> DocumentMeta {
  DocumentMeta {
    title: m.title.clone(),
    author: m.author.clone(),
    created: m.created.clone(),
    modified: m.modified.clone(),
    pages: m.pages.map(f64::from),
    words: m.words.map(f64::from),
    ..DocumentMeta::default()
  }
}

/// An image becomes an evidence card whose picture it is, a document a document card;
/// anything else, or a file that will not even store, is None.
pub fn media_draft(file_name: &str, bytes: &[u8], store: &mut impl Store, ocr: impl Fn(&[u8]) -> String) -> Option<MediaDraft> {
  let kind = kind_of(file_name).filter(|k| matches!(k, FileKind::Image | FileKind::Document))?;
  let file = store(bytes, &ext_of(Some(file_name), None))?;
  let meta = read_meta(bytes);
  Some(if kind == FileKind::Image {
    let text = Some(ocr(bytes)).filter(|t| usable_ocr(t));
    MediaDraft {
      kind: CardKind::Evidence,
      title: text.as_deref().map_or_else(|| base_name(file_name).to_string(), ocr_title),
      notes: text,
      image_file: Some(file),
      image_meta: image_meta(&meta),
      occurred_at: meta.taken_at.and_then(UtcInstant::new),
      document: None,
    }
  } else {
    document_draft(file_name, file, &meta)
  })
}

fn document_draft(file_name: &str, file: String, meta: &MediaMeta) -> MediaDraft {
  MediaDraft {
    kind: CardKind::Document,
    title: meta.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(base_name(file_name)).to_string(),
    notes: None,
    image_file: None,
    image_meta: None,
    occurred_at: meta.created.clone().and_then(UtcInstant::new),
    document: Some(DocumentMeta {
      file: Some(file),
      name: Some(file_name.to_string()),
      mime: document_mime(file_name).map(str::to_string),
      ..document_props(meta)
    }),
  }
}

/// Any file, kept as a document card's file with what can be read of it.
#[tauri::command(async)]
pub fn attach_document(app: AppHandle, path: String) -> Result<MediaDraft, String> {
  let path = Path::new(&path);
  let bytes = std::fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
  let name = file_name(path);
  let file = store_media_bytes(&app, &bytes, &ext_of(Some(&name), None))?;
  Ok(document_draft(&name, file, &read_meta(&bytes)))
}

pub(crate) fn app_media_draft(app: &AppHandle, file_name: &str, bytes: &[u8]) -> Option<MediaDraft> {
  media_draft(file_name, bytes, &mut media_store(app), ocr_bytes)
}

/// The pictures and documents the user picked, as cards to place. A file that won't
/// read or store drops out rather than sinking the batch.
#[tauri::command(async)]
pub fn import_media_files(app: AppHandle, paths: Vec<String>) -> Vec<MediaDraft> {
  paths
    .iter()
    .map(Path::new)
    .filter_map(|path| match std::fs::read(path) {
      Ok(bytes) => app_media_draft(&app, &file_name(path), &bytes),
      Err(e) => {
        log::warn!("Could not read {}: {e}", path.display());
        None
      }
    })
    .collect()
}

/// The card a stored media file makes, read again: to adopt an orphan, or to refresh
/// a card's metadata and recognised text.
#[tauri::command(async)]
pub fn media_card_draft(app: AppHandle, name: String) -> Result<Option<MediaDraft>, String> {
  Ok(app_media_draft(&app, &name, &read_media(&app, &name)?))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn kept() -> impl Store {
    |_: &[u8], ext: &str| Some(format!("hash.{ext}"))
  }

  #[test]
  fn usable_ocr_keeps_captured_writing_and_drops_fragments() {
    assert!(usable_ocr("Yes! 3pm at the cafe on King St."));
    assert!(usable_ocr("Hey are we\nstill on for tomorrow"));
    for fragment in ["", "   \n  ", "STOP", "Main St"] {
      assert!(!usable_ocr(fragment), "{fragment:?}");
    }
  }

  #[test]
  fn ocr_title_takes_the_first_line_and_caps_it() {
    assert_eq!(ocr_title("  \nHey there\nsecond line"), "Hey there");
    let title = ocr_title(&"a".repeat(80));
    assert_eq!(title.chars().count(), 60);
    assert!(title.ends_with('…'));
    assert_eq!(ocr_title(""), "");
  }

  #[test]
  fn a_screenshot_is_titled_and_noted_by_its_text() {
    let draft = media_draft("IMG_1.png", b"not really a png", &mut kept(), |_| "See you at nine\nok?? sure".into()).unwrap();
    assert_eq!(draft.kind, CardKind::Evidence);
    assert_eq!(draft.title, "See you at nine");
    assert_eq!(draft.notes.as_deref(), Some("See you at nine\nok?? sure"));
    assert_eq!(draft.image_file.as_deref(), Some("hash.png"));
    assert_eq!(draft.image_meta, None);
  }

  #[test]
  fn a_photo_with_no_real_text_keeps_its_filename() {
    let draft = media_draft("dir/Beach Day.JPG", b"x", &mut kept(), |_| "STOP".into()).unwrap();
    assert_eq!((draft.title.as_str(), draft.notes), ("Beach Day", None));
  }

  #[test]
  fn a_document_carries_its_file_name_and_type() {
    let draft = media_draft("brief.pdf", b"%PDF-broken", &mut kept(), |_| unreachable!()).unwrap();
    assert_eq!(draft.kind, CardKind::Document);
    assert_eq!(draft.title, "brief");
    let doc = draft.document.unwrap();
    assert_eq!(doc.file.as_deref(), Some("hash.pdf"));
    assert_eq!(doc.name.as_deref(), Some("brief.pdf"));
    assert_eq!(doc.mime.as_deref(), Some("application/pdf"));
  }

  #[test]
  fn other_files_and_failed_stores_make_no_card() {
    assert_eq!(media_draft("notes.md", b"x", &mut kept(), |_| String::new()), None);
    assert_eq!(media_draft("a.eml", b"x", &mut kept(), |_| String::new()), None);
    assert_eq!(media_draft("a.png", b"x", &mut |_: &[u8], _: &str| None, |_| String::new()), None);
  }

  #[test]
  fn only_real_metadata_becomes_image_meta() {
    assert_eq!(image_meta(&MediaMeta::default()), None);
    let meta = MediaMeta { width: Some(1288), height: Some(672), ..MediaMeta::default() };
    assert_eq!(image_meta(&meta), Some(ImageMeta { width: Some(1288.0), height: Some(672.0), ..ImageMeta::default() }));
  }
}
