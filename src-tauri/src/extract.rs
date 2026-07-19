//! Body text out of an imported file, for the search index.
//!
//! `extract_media_meta` (board_store) reads a file's *properties* — a PDF's page
//! count, an Office file's title. This reads its *words*: the PDF's page text, the
//! Word/PowerPoint/Excel body, a plain file or `.eml` as-is, or a screenshot's text
//! through OCR. Dispatch is by leading bytes, like the metadata reader, so a file
//! renamed to the wrong extension is still read for what it actually is. Best-effort
//! throughout: a file that won't parse is `Failed`, a kind with no text extractor is
//! `Unsupported`, and neither fails the caller — both are recorded and moved past.
//!
//! No database, no card schema, no Tauri: this is pure bytes-in, text-out, so it
//! unit-tests without any of them.

use quick_xml::events::Event;

use crate::board_store::read_zip_entry;

/// What reading a file's text came to.
pub enum ExtractOutcome {
  /// The text, possibly empty (a scanned PDF with no text layer, say).
  Text(String),
  /// A kind we have no text extractor for (audio, video, an unknown binary).
  Unsupported,
  /// A kind we should read but couldn't — a corrupt PDF, an unreadable zip.
  Failed(String),
}

/// The most text we keep from one file, so an enormous PDF can't bloat the index or
/// hold a lot of memory. 8 MiB of text is far more words than any search needs.
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

pub fn extract_text(bytes: &[u8], ext: &str) -> ExtractOutcome {
  if bytes.starts_with(b"%PDF") {
    pdf_text(bytes)
  } else if bytes.starts_with(b"PK\x03\x04") {
    ooxml_text(bytes)
  } else if imagesize::blob_size(bytes).is_ok() {
    ocr_text(bytes)
  } else if is_plain_ext(ext) {
    ExtractOutcome::Text(cap(String::from_utf8_lossy(bytes).into_owned()))
  } else {
    ExtractOutcome::Unsupported
  }
}

/// Text formats we read as-is. `.eml` lands here: its headers and (quoted-printable)
/// body are good enough for search, which is only ever more than the truncated body
/// already carried in a card's notes.
fn is_plain_ext(ext: &str) -> bool {
  matches!(
    ext.to_ascii_lowercase().as_str(),
    "eml" | "mbox" | "txt" | "text" | "md" | "markdown" | "csv" | "tsv" | "log"
  )
}

/// Truncate to a char boundary at or below the cap — `from_utf8_lossy` and the
/// extractors all produce valid UTF-8, and the cap may land mid-character.
fn cap(mut s: String) -> String {
  if s.len() > MAX_TEXT_BYTES {
    let mut end = MAX_TEXT_BYTES;
    while !s.is_char_boundary(end) {
      end -= 1;
    }
    s.truncate(end);
  }
  s
}

// ---- PDF (lopdf) ----

fn pdf_text(bytes: &[u8]) -> ExtractOutcome {
  let doc = match lopdf::Document::load_mem(bytes) {
    Ok(d) => d,
    Err(e) => return ExtractOutcome::Failed(format!("The PDF wouldn't parse: {e}")),
  };
  let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
  let mut text = String::new();
  // In batches, so a single unreadable page doesn't cost the whole batch — a batch
  // that errors is retried page by page — and with an overall cap for a huge file.
  for batch in pages.chunks(50) {
    if text.len() >= MAX_TEXT_BYTES {
      break;
    }
    match doc.extract_text(batch) {
      Ok(t) => push_page(&mut text, &t),
      Err(_) => {
        for &page in batch {
          if let Ok(t) = doc.extract_text(&[page]) {
            push_page(&mut text, &t);
          }
        }
      }
    }
  }
  ExtractOutcome::Text(cap(text))
}

fn push_page(text: &mut String, page: &str) {
  text.push_str(page);
  text.push('\n');
}

// ---- Office / OOXML (zip + quick-xml) ----

fn ooxml_text(bytes: &[u8]) -> ExtractOutcome {
  let mut zip = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
    Ok(z) => z,
    Err(e) => return ExtractOutcome::Failed(format!("The Office file wouldn't open: {e}")),
  };
  // The parts that hold body text, across Word/PowerPoint/Excel. Collected first so
  // the immutable borrow ends before the file is read for each.
  let parts: Vec<String> = zip.file_names().filter(|n| is_body_part(n)).map(String::from).collect();
  let mut text = String::new();
  for part in &parts {
    if text.len() >= MAX_TEXT_BYTES {
      break;
    }
    if let Some(xml) = read_zip_entry(&mut zip, part) {
      collect_run_text(&xml, &mut text);
      text.push('\n');
    }
  }
  ExtractOutcome::Text(cap(text))
}

fn is_body_part(name: &str) -> bool {
  name == "word/document.xml"
    || name.starts_with("word/header")
    || name.starts_with("word/footer")
    || (name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
    || name == "xl/sharedStrings.xml"
}

/// Every text run's contents. Word (`w:t`), PowerPoint (`a:t`) and Excel (`t`) all
/// carry their visible text in an element whose local name is `t`, so this collects
/// exactly the body without needing to know the namespaces apart.
fn collect_run_text(xml: &str, out: &mut String) {
  let mut reader = quick_xml::Reader::from_str(xml);
  let mut depth = 0u32;
  loop {
    match reader.read_event() {
      Ok(Event::Start(e)) if e.name().local_name().as_ref() == b"t" => depth += 1,
      Ok(Event::End(e)) if e.name().local_name().as_ref() == b"t" && depth > 0 => depth -= 1,
      Ok(Event::Text(t)) if depth > 0 => {
        if let Ok(txt) = t.unescape() {
          out.push_str(&txt);
          out.push(' ');
        }
      }
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
  }
}

// ---- Images (OCR, macOS only) ----

#[cfg(target_os = "macos")]
fn ocr_text(bytes: &[u8]) -> ExtractOutcome {
  ExtractOutcome::Text(cap(crate::ocr::recognise_text(bytes)))
}

/// No OCR engine off macOS, so an image carries no searchable text there.
#[cfg(not(target_os = "macos"))]
fn ocr_text(_bytes: &[u8]) -> ExtractOutcome {
  ExtractOutcome::Unsupported
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text_of(o: ExtractOutcome) -> String {
    match o {
      ExtractOutcome::Text(t) => t,
      ExtractOutcome::Unsupported => panic!("expected text, got unsupported"),
      ExtractOutcome::Failed(e) => panic!("expected text, got failed: {e}"),
    }
  }

  #[test]
  fn reads_plain_text_and_eml() {
    assert!(text_of(extract_text(b"hello world", "txt")).contains("hello world"));
    assert!(text_of(extract_text(b"Subject: Hi\r\n\r\nthe body", "eml")).contains("the body"));
  }

  #[test]
  fn unknown_binary_is_unsupported() {
    assert!(matches!(extract_text(&[0x00, 0x01, 0x02, 0x03], "bin"), ExtractOutcome::Unsupported));
  }

  #[test]
  fn a_broken_pdf_fails_rather_than_panics() {
    assert!(matches!(extract_text(b"%PDF-1.4 not really a pdf", "pdf"), ExtractOutcome::Failed(_)));
  }

  #[test]
  fn collects_word_run_text() {
    let xml = r#"<w:document><w:body><w:p>
      <w:r><w:t>Hello</w:t></w:r><w:r><w:t>World</w:t></w:r>
    </w:p></w:body></w:document>"#;
    let mut out = String::new();
    collect_run_text(xml, &mut out);
    assert!(out.contains("Hello"));
    assert!(out.contains("World"));
  }
}
