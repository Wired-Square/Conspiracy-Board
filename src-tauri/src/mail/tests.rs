use super::mbox::split_mbox;
use super::*;

const EML: &[u8] = include_bytes!("../../tests/fixtures/mail/sample.eml");
const MBOX: &[u8] = include_bytes!("../../tests/fixtures/mail/sample.mbox");
const ATTACHMENTS: &[u8] = include_bytes!("../../tests/fixtures/mail/attachments.eml");
const APPLE_INLINE: &[u8] = include_bytes!("../../tests/fixtures/mail/apple-inline.eml");
const HTML_ONLY: &[u8] = include_bytes!("../../tests/fixtures/mail/html-only.eml");
const MIXED_CHARSETS: &[u8] = include_bytes!("../../tests/fixtures/mail/mixed-charsets.mbox");

/// A media store in memory: what was kept, by the name it was kept under.
#[derive(Default)]
struct Kept(Vec<(String, Vec<u8>)>);

impl Kept {
  fn store(&mut self) -> impl Store + '_ {
    |bytes: &[u8], ext: &str| {
      let name = format!("m{}.{ext}", self.0.len());
      self.0.push((name.clone(), bytes.to_vec()));
      Some(name)
    }
  }

  fn bytes(&self, name: &str) -> &[u8] {
    &self.0.iter().find(|(n, _)| n == name).unwrap().1
  }
}

fn parse_named(name: &str, bytes: &[u8]) -> (EmailParse, Kept) {
  let mut kept = Kept::default();
  let out = parse_file(name, bytes, &mut kept.store(), &mut |_, _| {});
  (out, kept)
}

fn crlf(bytes: &[u8]) -> Vec<u8> {
  String::from_utf8(bytes.to_vec()).unwrap().replace('\n', "\r\n").into_bytes()
}

fn addr(name: Option<&str>, address: &str) -> EmailAddress {
  EmailAddress { name: name.map(str::to_string), address: address.to_string() }
}

mod eml {
  use super::*;

  #[test]
  fn maps_the_headers_onto_card_fields() {
    let (out, _) = parse_named("sample.eml", &crlf(EML));
    assert!(out.errors.is_empty());
    let d = &out.drafts[0];
    assert_eq!(d.kind, CardKind::Email);
    assert_eq!(d.title, "Re: the “collection”");
    assert_eq!(d.email.from, Some(addr(Some("Sable, Dominic"), "dutch@bluecanary.example")));
    assert_eq!(d.email.to.len(), 2);
    assert_eq!(d.email.cc, vec![addr(None, "legal@bluecanary.example")]);
    assert_eq!(d.email.message_id.as_deref(), Some("<abc123@bluecanary.example>"));
    assert_eq!(d.email.in_reply_to.as_deref(), Some("<prev999@example.com>"));
  }

  #[test]
  fn normalises_the_date_header_offset_to_a_utc_instant() {
    let d = &parse_named("sample.eml", EML).0.drafts[0];
    assert_eq!(d.occurred_at, UtcInstant::new("2024-11-15T01:32:11.000Z".into()));
    assert_eq!(d.occurred_at_precision, DatePrecision::Minute);
  }

  #[test]
  fn decodes_a_quoted_printable_body_into_notes() {
    assert!(parse_named("sample.eml", EML).0.drafts[0].notes.contains("Per our call — the collection was moved."));
  }

  #[test]
  fn imports_a_message_with_no_date_as_undated_rather_than_dropping_it() {
    let (out, _) = parse_named("nodate.eml", b"From: a@x.example\nSubject: No date\n\nbody\n");
    assert!(out.errors.is_empty());
    assert_eq!(out.drafts[0].occurred_at, None);
    assert_eq!(out.drafts[0].title, "No date");
  }

  #[test]
  fn falls_back_to_a_placeholder_title_when_there_is_no_subject() {
    assert_eq!(parse_named("nosubj.eml", b"From: a@x.example\n\nbody\n").0.drafts[0].title, "(no subject)");
  }

  #[test]
  fn keeps_the_whole_message_as_its_eml() {
    let (out, kept) = parse_named("sample.eml", EML);
    assert_eq!(kept.bytes(out.drafts[0].email.eml_file.as_deref().unwrap()), EML);
  }

  #[test]
  fn converts_an_html_only_body() {
    let notes = &parse_named("news.eml", HTML_ONLY).0.drafts[0].notes;
    assert_eq!(
      notes,
      "# Top story\n\nRead [the piece](https://x.example/a?b=1&c=2) now.\n\n- One\n\n- Two & three\n\nWrite to the editor or see https://x.example."
    );
  }
}

mod mbox_files {
  use super::*;

  #[test]
  fn splits_into_one_draft_per_message() {
    let (out, _) = parse_named("sample.mbox", MBOX);
    assert!(out.errors.is_empty());
    let titles: Vec<_> = out.drafts.iter().map(|d| d.title.as_str()).collect();
    assert_eq!(titles, vec!["First message", "Second message"]);
    let ids: Vec<_> = out.drafts.iter().map(|d| d.email.message_id.as_deref().unwrap()).collect();
    assert_eq!(ids, vec!["<m1@x.example>", "<m2@x.example>"]);
  }

  #[test]
  fn does_not_split_on_a_body_line_starting_with_from() {
    assert!(parse_named("sample.mbox", MBOX).0.drafts[1].notes.contains("From what I heard"));
  }

  #[test]
  fn unescapes_mboxrd_from_quoting_in_the_body() {
    let notes = &parse_named("sample.mbox", MBOX).0.drafts[0].notes;
    assert!(notes.contains("From the top") && !notes.contains(">From the top"));
  }

  #[test]
  fn sniffs_an_mbox_regardless_of_its_extension() {
    assert_eq!(parse_named("export.txt", MBOX).0.drafts.len(), 2);
  }

  /// The bug this module fixes: the whole mbox used to be decoded as UTF-8 before it
  /// was split, so a message in another charset was garbled before its own
  /// Content-Type could be read.
  #[test]
  fn decodes_each_message_in_its_own_charset() {
    let (out, kept) = parse_named("mixed.mbox", MIXED_CHARSETS);
    assert!(out.errors.is_empty());
    assert!(out.drafts[0].notes.contains("Un café en UTF-8."));
    assert_eq!(out.drafts[1].title, "Résumé");
    assert!(out.drafts[1].notes.contains("Un café en Latin-1, déjà vu."), "{}", out.drafts[1].notes);
    // The kept .eml is the message's own bytes, Latin-1 and all.
    let eml = kept.bytes(out.drafts[1].email.eml_file.as_deref().unwrap());
    assert!(eml.windows(5).any(|w| w == b"caf\xe9 "));
  }
}

mod attachments {
  use super::*;

  fn names(d: &EmailDraft) -> Vec<&str> {
    d.email.attachments.iter().map(|a| a.name.as_str()).collect()
  }

  #[test]
  fn keeps_real_attachments_dropping_inline_layout_images() {
    let (out, _) = parse_named("mp.eml", &crlf(ATTACHMENTS));
    assert!(out.errors.is_empty());
    assert_eq!(names(&out.drafts[0]), vec!["contract.pdf", "notes.txt"]);
  }

  #[test]
  fn files_every_attachment_including_a_text_part() {
    let (out, kept) = parse_named("mp.eml", ATTACHMENTS);
    let a = &out.drafts[0].email.attachments;
    assert_eq!(kept.bytes(a[0].file.as_deref().unwrap()), b"pretend-pdf-bytes");
    assert!(kept.bytes(a[1].file.as_deref().unwrap()).starts_with(b"a plain text note"));
    assert_eq!(a[0].mime.as_deref(), Some("application/pdf"));
    assert!(a[0].file.as_deref().unwrap().ends_with(".pdf"));
  }

  #[test]
  fn promotes_the_first_real_image_to_the_picture_not_an_inline_logo() {
    let (out, kept) = parse_named("mp.eml", ATTACHMENTS);
    let picture = out.drafts[0].image_file.as_deref().unwrap();
    assert!(picture.ends_with(".png"));
    assert_eq!(kept.bytes(picture), b"pretend-photo-png");
  }

  #[test]
  fn lists_only_the_real_attachments_in_the_notes_summary() {
    assert!(parse_named("mp.eml", ATTACHMENTS).0.drafts[0].notes.contains("**Attachments:** contract.pdf, notes.txt"));
  }

  #[test]
  fn keeps_an_apple_mail_inline_document_with_a_filename_and_no_content_id() {
    let (out, kept) = parse_named("apple.eml", &crlf(APPLE_INLINE));
    assert!(out.errors.is_empty());
    assert_eq!(names(&out.drafts[0]), vec!["report.pdf"]);
    assert_eq!(kept.bytes(out.drafts[0].email.attachments[0].file.as_deref().unwrap()), b"pretend-pdf-bytes");
  }

  #[test]
  fn recovering_a_kept_eml_finds_its_attachments_and_spares_a_chosen_picture() {
    let mut kept = Kept::default();
    let found = recover(ATTACHMENTS, true, &mut kept.store()).unwrap();
    assert_eq!(found.image_file, None);
    assert_eq!(found.attachments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["contract.pdf", "notes.txt"]);
    assert!(recover(ATTACHMENTS, false, &mut kept.store()).unwrap().image_file.is_some());
    assert!(!kept.0.iter().any(|(n, _)| n.ends_with(".eml")));
  }
}

mod pasted {
  use super::*;

  fn paste(text: &str) -> EmailParse {
    parse_text(text, &mut Kept::default().store(), &mut |_, _| {})
  }

  #[test]
  fn parses_a_pasted_raw_message() {
    let out = paste(std::str::from_utf8(EML).unwrap());
    assert!(out.errors.is_empty());
    assert_eq!(out.drafts[0].title, "Re: the “collection”");
  }

  #[test]
  fn reports_an_error_for_empty_input() {
    let out = paste("   ");
    assert!(out.drafts.is_empty());
    assert_eq!(out.errors.len(), 1);
  }

  #[test]
  fn parses_a_pasted_mbox() {
    assert_eq!(paste(std::str::from_utf8(MBOX).unwrap()).drafts.len(), 2);
  }
}

mod splitting {
  use super::*;

  fn msg(from: &str, subject: &str, body: &str) -> String {
    format!("From {from} Mon Jan 1 00:00:00 2024\nFrom: {from}\nSubject: {subject}\n\n{body}\n")
  }

  fn split(text: &str) -> Vec<String> {
    split_mbox(text.as_bytes()).into_iter().map(|m| String::from_utf8(m).unwrap()).collect()
  }

  #[test]
  fn recognises_a_from_line_at_the_start() {
    assert!(looks_like_mbox(b"From a@b.com Mon Jan 1 00:00:00 2024\nFrom: a@b.com\n"));
  }

  #[test]
  fn recognises_the_google_takeout_from_format() {
    assert!(looks_like_mbox(b"From 1798384@xxx Sat Nov 16 10:15:00 +0000 2024\nFrom: a@b.com\n"));
  }

  #[test]
  fn does_not_mistake_a_plain_eml_or_prose_for_an_mbox() {
    assert!(!looks_like_mbox(b"From: a@b.com\nSubject: hi\n\nbody"));
    assert!(!looks_like_mbox(b"From what I heard, the store was seized."));
  }

  #[test]
  fn splits_multiple_messages() {
    let out = split(&format!("{}\n{}", msg("a@x.com", "One", "first"), msg("b@x.com", "Two", "second")));
    assert_eq!(out.len(), 2);
    assert!(out[0].contains("Subject: One") && out[1].contains("Subject: Two"));
  }

  #[test]
  fn drops_the_from_separator_from_the_message() {
    assert!(split(&msg("a@x.com", "One", "first"))[0].starts_with("From: a@x.com"));
  }

  #[test]
  fn does_not_split_on_a_body_line_that_merely_starts_with_from() {
    let out = split("From a@x.com Mon Jan 1 00:00:00 2024\nFrom: a@x.com\nSubject: One\n\nQuoting them:\nFrom what I heard, the store was seized.\n");
    assert_eq!(out.len(), 1);
    assert!(out[0].contains("From what I heard"));
  }

  #[test]
  fn keeps_a_body_whose_very_first_line_starts_with_from() {
    let out = split("From a@x.com Mon Jan 1 00:00:00 2024\nFrom: a@x.com\nSubject: One\n\nFrom what I heard, the store was seized.\n");
    assert_eq!(out.len(), 1);
    assert!(out[0].contains("From what I heard"));
  }

  #[test]
  fn unescapes_mboxrd_from_quoting_one_level() {
    let out = &split("From a@x.com Mon Jan 1 00:00:00 2024\nFrom: a@x.com\nSubject: One\n\n>From the top\n>>From nested\n")[0];
    assert!(out.contains("\nFrom the top") && out.contains("\n>From nested"));
  }

  #[test]
  fn returns_no_trailing_empty_message() {
    assert_eq!(split(&format!("{}\n\n\n", msg("a@x.com", "One", "first"))).len(), 1);
  }

  #[test]
  fn handles_crlf_line_endings() {
    let out = split(&msg("a@x.com", "One", "first").replace('\n', "\r\n"));
    assert_eq!(out.len(), 1);
    assert!(out[0].contains("Subject: One"));
  }

  #[test]
  fn returns_nothing_for_empty_input() {
    assert!(split("").is_empty());
  }
}
