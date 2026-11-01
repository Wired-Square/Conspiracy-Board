//! Body text out of an imported file, for the search index.
//!
//! `meta` reads a file's *properties* — a PDF's page
//! count, an Office file's title. This reads its *words*: the PDF's page text, the
//! Word/PowerPoint/Excel body, a plain file or `.eml` as-is, or a screenshot's text
//! through OCR. Dispatch is by leading bytes, like the metadata reader, so a file
//! renamed to the wrong extension is still read for what it actually is. Best-effort
//! throughout: a file that won't parse is `Failed`, a kind with no text extractor is
//! `Unsupported`, and neither fails the caller — both are recorded and moved past.
//!
//! No database, no card schema, no Tauri: this is pure bytes-in, text-out, so it
//! unit-tests without any of them.

pub mod meta;

use std::io::Read;

use quick_xml::events::Event;

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

// ---- PDF (lopdf, then PDFKit and Vision for what it can't read) ----

/// A page whose text layer has fewer visible characters than this is read as a scan.
const SCANNED_PAGE_CHARS: usize = 20;
/// The most pages of one PDF we OCR, so one huge scan can't hold the indexer for long.
const MAX_OCR_PAGES: usize = 200;

#[cfg(target_os = "macos")]
fn pdf_text(bytes: &[u8]) -> ExtractOutcome {
  use crate::pdf_kit::PdfKitDocument;

  let (mut pages, kit) = match lopdf::Document::load_mem(bytes) {
    Ok(doc) => (text_layer(&doc), None),
    Err(e) => match PdfKitDocument::open(bytes) {
      Some(kit) => ((0..kit.page_count()).map(|i| kit.page_text(i)).collect(), Some(kit)),
      None => return unparsable(e),
    },
  };
  let scanned: Vec<usize> =
    (0..pages.len()).filter(|&i| visible_chars(&pages[i]) < SCANNED_PAGE_CHARS).take(MAX_OCR_PAGES).collect();
  if !scanned.is_empty() {
    if let Some(kit) = kit.or_else(|| PdfKitDocument::open(bytes)) {
      for i in scanned {
        let read = kit.read_page(i);
        if visible_chars(&read) > visible_chars(&pages[i]) {
          pages[i] = read;
        }
      }
    }
  }
  ExtractOutcome::Text(cap(pages.join("\n")))
}

#[cfg(not(target_os = "macos"))]
fn pdf_text(bytes: &[u8]) -> ExtractOutcome {
  match lopdf::Document::load_mem(bytes) {
    Ok(doc) => ExtractOutcome::Text(cap(text_layer(&doc).join("\n"))),
    Err(e) => unparsable(e),
  }
}

fn unparsable(e: lopdf::Error) -> ExtractOutcome {
  ExtractOutcome::Failed(format!("The PDF wouldn't parse: {e}"))
}

/// Each page's text, in order, stopping once the cap is reached. A page that won't
/// read is empty, so it doesn't cost the rest.
fn text_layer(doc: &lopdf::Document) -> Vec<String> {
  let mut total = 0;
  doc
    .get_pages()
    .keys()
    .map_while(|&page| {
      (total < MAX_TEXT_BYTES).then(|| {
        let text = doc.extract_text(&[page]).unwrap_or_default();
        total += text.len();
        text
      })
    })
    .collect()
}

fn visible_chars(text: &str) -> usize {
  text.chars().filter(|c| !c.is_whitespace()).count()
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

fn read_zip_entry(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Option<String> {
  let mut f = zip.by_name(name).ok()?;
  let mut s = String::new();
  f.read_to_string(&mut s).ok()?;
  Some(s)
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

  enum TestPage<'a> {
    Typed(&'a str),
    Scanned(&'a str),
  }

  /// Objects 1-4 are the catalog, page tree, info and font; each page follows as its
  /// page object, its content stream and, for a scan, its image. The xref entries end
  /// in a bare newline, as Haru writes them.
  fn pdf_of(pages: &[TestPage]) -> Vec<u8> {
    let mut objects = vec![
      String::new(),
      String::new(),
      "<< /Producer (test) >>".to_string(),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut kids = Vec::new();
    for page in pages {
      let page_id = objects.len() + 1;
      kids.push(format!("{page_id} 0 R"));
      let (content, resources, image) = match page {
        TestPage::Typed(text) => (format!("BT /F1 24 Tf 20 40 Td ({text}) Tj ET"), "/Font << /F1 4 0 R >>".to_string(), None),
        TestPage::Scanned(text) => (
          "q 400 0 0 100 0 0 cm /Im1 Do Q".to_string(),
          format!("/XObject << /Im1 {} 0 R >>", page_id + 2),
          Some(scanned_image_of(text)),
        ),
      };
      objects.push(format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents {} 0 R /Resources << {resources} >> >>",
        page_id + 1
      ));
      objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
      objects.extend(image);
    }
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>".to_string();
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len());

    let mut pdf = b"%PDF-1.3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
      offsets.push(pdf.len());
      pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let (xref_at, size) = (pdf.len(), objects.len() + 1);
    pdf.extend(format!("xref\n0 {size}\n0000000000 65535 f\n").bytes());
    for offset in offsets {
      pdf.extend(format!("{offset:010} 00000 n\n").bytes());
    }
    pdf.extend(format!("trailer\n<< /Root 1 0 R /Info 3 0 R /Size {size} >>\nstartxref\n{xref_at}\n%%EOF\n").bytes());
    pdf
  }

  /// A typed page rendered to grey pixels and embedded as an image: legible text with
  /// no font and no text layer, which is what a scanner writes.
  fn scanned_image_of(text: &str) -> String {
    let typed = pdf_of(&[TestPage::Typed(text)]);
    let (width, height, pixels) =
      crate::pdf_kit::PdfKitDocument::open(&typed).and_then(|kit| kit.render_grey(0)).expect("the typed page renders");
    let hex: String = pixels.iter().map(|p| format!("{p:02x}")).collect();
    format!(
      "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray \
       /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length {} >>\nstream\n{hex}>\nendstream",
      hex.len() + 1
    )
  }

  #[test]
  fn reads_a_pdf_whose_xref_entries_end_in_a_bare_newline() {
    let pdf = pdf_of(&[TestPage::Typed("Hello trailer")]);
    assert!(text_of(extract_text(&pdf, "pdf")).contains("Hello trailer"));
  }

  #[test]
  fn reads_a_scanned_page_through_ocr() {
    let text = text_of(extract_text(&pdf_of(&[TestPage::Scanned("Scanned words")]), "pdf"));
    assert!(text.contains("Scanned words"), "OCR text was {text:?}");
  }

  #[test]
  fn reads_a_mixed_pdf_page_by_page_in_order() {
    let pdf = pdf_of(&[TestPage::Typed("Typed words from the text layer"), TestPage::Scanned("Scanned words")]);
    let text = text_of(extract_text(&pdf, "pdf"));
    let typed = text.find("Typed words from the text layer").expect("typed page text");
    let scanned = text.find("Scanned words").unwrap_or_else(|| panic!("no scanned page text in {text:?}"));
    assert!(typed < scanned, "pages out of order in {text:?}");
  }

  #[test]
  fn pdf_kit_reads_the_text_layer_lopdf_would() {
    let kit = crate::pdf_kit::PdfKitDocument::open(&pdf_of(&[TestPage::Typed("Kit words")])).expect("PDFKit opens it");
    assert!(kit.page_text(0).contains("Kit words"));
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
