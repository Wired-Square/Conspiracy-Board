//! Email: an .eml, an mbox or a pasted message parsed into card drafts, with the
//! original message and its attachments kept in the media library.
//!
//! Each message is parsed from its own bytes, so its declared charset is honoured;
//! an mbox is split on bytes too (`mbox`), never decoded whole.

mod html;
mod mbox;

use std::path::Path;

use mail_parser::{MessageParser, MessagePart, MessageRef};
use tauri::{AppHandle, Emitter};

use crate::board_store::media::{media_store, read_media, Store};
use crate::file_types::{ext_of, file_name};
use crate::schema::{CardKind, DatePrecision, EmailAddress, EmailAttachment, EmailMeta, UtcInstant};

use mbox::looks_like_mbox;

/// A card's notes are a note on a corkboard, not an archive of the message, which is
/// kept whole as its .eml; and marketing mail routinely carries 200KB of inlined CSS.
const MAX_NOTES: usize = 20_000;

/// A parsed message as the fields of the card it will become, its media already kept.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmailDraft {
  pub title: String,
  pub notes: String,
  pub occurred_at: Option<UtcInstant>,
  pub occurred_at_precision: DatePrecision,
  #[cfg_attr(test, ts(type = "\"email\""))]
  pub kind: CardKind,
  pub email: EmailMeta,
  /// The first real image the message carried, as the card's picture.
  pub image_file: Option<String>,
  /// What the message costs on disk, for the import preview.
  pub bytes: usize,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct EmailParse {
  pub drafts: Vec<EmailDraft>,
  pub errors: Vec<String>,
}

/// One part of a message to keep: what it was called, its type, and its bytes.
struct Part {
  name: String,
  mime: Option<String>,
  bytes: Vec<u8>,
}

/// A message read but not yet stored.
struct Parsed {
  title: String,
  notes: String,
  occurred_at: Option<UtcInstant>,
  email: EmailMeta,
  picture: Option<Part>,
  attachments: Vec<Part>,
}

fn parse(raw: &[u8]) -> Result<Parsed, String> {
  let message = MessageParser::new().parse(raw).ok_or("Not an email message")?;
  let msg = message.root();
  let body = body_text(&msg);

  // Inline parts — a signature logo, a tracking pixel, an image the HTML body
  // references by cid — are layout, not documents.
  let mut real: Vec<Part> = msg.attachments().filter(|p| !is_inline_part(p)).map(part).collect();
  let picture = real
    .iter()
    .position(|p| p.mime.as_deref().is_some_and(|m| m.starts_with("image/")))
    .map(|i| real.remove(i));
  for (i, a) in real.iter_mut().enumerate() {
    if a.name.is_empty() {
      a.name = format!("attachment-{}", i + 1);
    }
  }
  let names: Vec<&str> = real.iter().map(|a| a.name.as_str()).collect();
  let notes = if names.is_empty() { body } else { format!("{body}\n\n**Attachments:** {}", names.join(", ")) };

  Ok(Parsed {
    title: msg.subject().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("(no subject)").to_string(),
    notes: truncate(notes),
    occurred_at: msg.date().filter(|d| d.is_valid()).and_then(|d| UtcInstant::new(iso_utc(d.to_timestamp()))),
    email: EmailMeta {
      from: msg.from().and_then(|list| list.mailboxes().find_map(address)),
      to: msg.to().map(|list| list.mailboxes().filter_map(address).collect()).unwrap_or_default(),
      cc: msg.cc().map(|list| list.mailboxes().filter_map(address).collect()).unwrap_or_default(),
      message_id: msg.message_id().map(str::trim).filter(|s| !s.is_empty()).map(|id| format!("<{id}>")),
      in_reply_to: msg
        .in_reply_to()
        .map(|ids| ids.iter().map(|id| format!("<{}>", id.trim())).collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty()),
      ..EmailMeta::default()
    },
    picture,
    attachments: real,
  })
}

/// The text parts, or failing those the HTML one converted.
fn body_text(msg: &MessageRef) -> String {
  use mail_parser::PartKind;
  let text: Vec<String> =
    msg.text_body().filter(|p| matches!(p.kind(), PartKind::Text)).filter_map(|p| p.text()).map(|t| t.into_owned()).collect();
  let text = text.join("\n");
  if !text.trim().is_empty() {
    return text;
  }
  msg
    .html_body()
    .find(|p| matches!(p.kind(), PartKind::Html))
    .and_then(|p| p.text())
    .map_or_else(String::new, |html| html::html_to_text(&html))
}

/// Disposition is not the signal it looks like: Apple Mail marks a genuine PDF
/// `inline` so it previews in the message. Layout rides in multipart/related or
/// carries a Content-ID.
fn is_inline_part(part: &MessagePart) -> bool {
  let related = part.parent().and_then(|p| p.content_type()).is_some_and(|ct| {
    ct.ctype().eq_ignore_ascii_case("multipart") && ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("related"))
  });
  related || part.content_id().is_some()
}

fn part(p: MessagePart) -> Part {
  Part {
    name: p.attachment_name().map(str::trim).unwrap_or_default().to_string(),
    mime: p.content_type().map(|ct| match ct.subtype() {
      Some(sub) => format!("{}/{}", ct.ctype(), sub).to_ascii_lowercase(),
      None => ct.ctype().to_ascii_lowercase(),
    }),
    bytes: p.decoded().into_owned(),
  }
}

fn address(m: mail_parser::Mailbox) -> Option<EmailAddress> {
  let address = m.address().map(str::trim).filter(|a| !a.is_empty())?;
  let name = m.name().map(str::trim).filter(|n| !n.is_empty());
  Some(EmailAddress { name: name.map(str::to_string), address: address.to_string() })
}

fn truncate(text: String) -> String {
  match text.char_indices().nth(MAX_NOTES) {
    Some((cut, _)) => format!("{}\n\n_[truncated]_", &text[..cut]),
    None => text,
  }
}

/// `YYYY-MM-DDTHH:MM:SS.000Z`, as `Date#toISOString` writes it.
fn iso_utc(timestamp: i64) -> String {
  let d = mail_parser::DateTime::from_timestamp(timestamp);
  format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", d.year, d.month, d.day, d.hour, d.minute, d.second)
}

fn keep(part: &Part, store: &mut impl Store) -> Option<String> {
  store(&part.bytes, &ext_of(Some(&part.name).filter(|n| !n.is_empty()).map(String::as_str), part.mime.as_deref()))
}

fn kept_attachments(parsed: &Parsed, store: &mut impl Store) -> Vec<EmailAttachment> {
  parsed
    .attachments
    .iter()
    .map(|a| EmailAttachment { name: a.name.clone(), file: keep(a, store), mime: a.mime.clone() })
    .collect()
}

fn draft(raw: &[u8], store: &mut impl Store) -> Result<EmailDraft, String> {
  let parsed = parse(raw)?;
  let attachments = kept_attachments(&parsed, store);
  let image_file = parsed.picture.as_ref().and_then(|p| keep(p, store));
  let media: usize = parsed.attachments.iter().chain(&parsed.picture).map(|p| p.bytes.len()).sum();
  let Parsed { title, notes, occurred_at, email, .. } = parsed;
  Ok(EmailDraft {
    bytes: notes.len() + media + raw.len(),
    image_file,
    title,
    notes,
    occurred_at,
    occurred_at_precision: DatePrecision::Minute,
    kind: CardKind::Email,
    email: EmailMeta { attachments, eml_file: store(raw, "eml"), ..email },
  })
}

/// Parse many raw messages, collecting per-message failures rather than stopping —
/// one bad message must not lose the rest of an mbox.
fn parse_all(raws: &[Vec<u8>], error: impl Fn(usize, String) -> String, store: &mut impl Store, progress: &mut impl FnMut(usize, usize)) -> EmailParse {
  let mut out = EmailParse::default();
  for (i, raw) in raws.iter().enumerate() {
    match draft(raw, store) {
      Ok(d) => out.drafts.push(d),
      Err(e) => out.errors.push(error(i, e)),
    }
    progress(i + 1, raws.len());
  }
  out
}

/// A picked or dropped file, sniffed rather than trusted by its extension: a dragged
/// mbox may be named .txt.
pub fn parse_file(name: &str, bytes: &[u8], store: &mut impl Store, progress: &mut impl FnMut(usize, usize)) -> EmailParse {
  if looks_like_mbox(bytes) || name.to_ascii_lowercase().ends_with(".mbox") {
    parse_all(&mbox::split_mbox(bytes), |i, e| format!("{name}: message {} — {e}", i + 1), store, progress)
  } else {
    parse_all(&[bytes.to_vec()], |_, e| format!("{name} — {e}"), store, progress)
  }
}

/// Pasted raw text (headers + body), or a pasted mbox.
pub fn parse_text(text: &str, store: &mut impl Store, progress: &mut impl FnMut(usize, usize)) -> EmailParse {
  let text = text.trim();
  if text.is_empty() {
    return EmailParse { drafts: vec![], errors: vec!["Nothing to parse.".into()] };
  }
  let raws = if looks_like_mbox(text.as_bytes()) { mbox::split_mbox(text.as_bytes()) } else { vec![text.as_bytes().to_vec()] };
  parse_all(&raws, |i, e| format!("Pasted text: message {} — {e}", i + 1), store, progress)
}

/// What re-reading a stored .eml finds: the attachments as the parser now sees them,
/// and the picture, unless the card already has one.
#[derive(Debug, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RecoveredEmail {
  pub image_file: Option<String>,
  pub attachments: Vec<EmailAttachment>,
}

pub fn recover(eml: &[u8], keep_picture: bool, store: &mut impl Store) -> Option<RecoveredEmail> {
  let raw = if looks_like_mbox(eml) { mbox::split_mbox(eml).into_iter().next()? } else { eml.to_vec() };
  let parsed = parse(&raw).ok()?;
  Some(RecoveredEmail {
    image_file: parsed.picture.as_ref().filter(|_| !keep_picture).and_then(|p| keep(p, store)),
    attachments: kept_attachments(&parsed, store),
  })
}

#[derive(Clone, serde::Serialize)]
struct EmailProgress {
  done: usize,
  total: usize,
}

fn progress(app: &AppHandle) -> impl FnMut(usize, usize) + '_ {
  move |done, total| {
    let _ = app.emit("email:progress", EmailProgress { done, total });
  }
}

/// The files the user picked, parsed and their media kept.
#[tauri::command(async)]
pub fn parse_email_files(app: AppHandle, paths: Vec<String>) -> EmailParse {
  let mut out = EmailParse::default();
  for path in paths.iter().map(Path::new) {
    let name = file_name(path);
    match std::fs::read(path) {
      Ok(bytes) => {
        let parsed = parse_file(&name, &bytes, &mut media_store(&app), &mut progress(&app));
        out.drafts.extend(parsed.drafts);
        out.errors.extend(parsed.errors);
      }
      Err(e) => out.errors.push(format!("{name} — {e}")),
    }
  }
  out
}

#[tauri::command(async)]
pub fn parse_email_text(app: AppHandle, text: String) -> EmailParse {
  parse_text(&text, &mut media_store(&app), &mut progress(&app))
}

/// Re-read an email card's kept .eml for the attachments an older import dropped
/// (Apple Mail's inline-disposition PDFs, chiefly). Additive and idempotent: media is
/// content-addressed, and the .eml itself is already stored.
#[tauri::command(async)]
pub fn recover_email_attachments(app: AppHandle, eml: String, keep_picture: bool) -> Result<Option<RecoveredEmail>, String> {
  Ok(recover(&read_media(&app, &eml)?, keep_picture, &mut media_store(&app)))
}

#[cfg(test)]
mod tests;
