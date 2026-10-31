//! A file's *properties* for the card made from it: a PDF's Info dictionary, an
//! Office file's docProps XML, or a photo's dimensions and EXIF.

use super::read_zip_entry;

/// Metadata pulled out of an imported file, to fill in the card made from it. Every
/// field is optional: a format that doesn't carry one, or a file we cannot parse,
/// simply omits it — extraction is best-effort and never fails the import. Dates are
/// ISO-8601 UTC so the webview can drop them straight onto a card's `occurredAt`.
#[derive(serde::Serialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) author: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) created: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) modified: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) pages: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) words: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) width: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) height: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) taken_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) camera_make: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) camera_model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) latitude: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(crate) longitude: Option<f64>,
}

pub fn read_meta(bytes: &[u8]) -> MediaMeta {
  if bytes.starts_with(b"%PDF") {
    pdf_meta(bytes)
  } else if bytes.starts_with(b"PK\x03\x04") {
    ooxml_meta(bytes)
  } else {
    image_meta(bytes)
  }
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
