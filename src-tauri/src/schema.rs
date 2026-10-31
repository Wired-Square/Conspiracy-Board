//! The board schema: the one definition of a board, its cards, connections and
//! clusters. The webview's types are generated from these (`src/bindings/`, see
//! `bindings.rs`), and every board read from disk or a bundle is validated and
//! migrated to the current version here.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

/// The board version this build writes; 1 to 3 are migrated on the way in.
pub const BOARD_VERSION: u8 = 4;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Board {
  #[cfg_attr(test, ts(type = "4"))]
  pub version: u8,
  pub meta: BoardMeta,
  pub clusters: Vec<Cluster>,
  pub cards: Vec<Card>,
  pub connections: Vec<Connection>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub viewport: Option<Viewport>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BoardMeta {
  pub title: String,
  pub updated_at: String,
  /// The local calling code (e.g. `+61`) a leading national `0` folds to when
  /// normalising phone numbers; absent means the default (Australia).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub country_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Vec2 {
  pub x: f64,
  pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Viewport {
  pub x: f64,
  pub y: f64,
  pub zoom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Cluster {
  pub id: String,
  pub label: String,
  pub color: String,
  pub visible: bool,
}

/// What a card is. The actors (`person`, `organisation`) and the record
/// (`document`, `email`, `message`, `call`) are never graded; the argument
/// (`event`, `evidence`) is. `evidence` is the default, which is what lets every
/// pre-v3 card, none of which carries a kind, arrive intact. See `src/lib/kinds.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
  Person,
  Organisation,
  Document,
  Email,
  Message,
  Call,
  Event,
  #[default]
  Evidence,
}

/// How well the record supports a claim, from a court's finding down to a claim the
/// record contradicts (definitions in GRADE_META, `src/lib/grades.ts`). Absent is not
/// `unresolved`: that is a finding about the record, where absent is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Grade {
  Adjudicated,
  Admitted,
  Confirmed,
  Corroborated,
  Asserted,
  Inference,
  Unresolved,
  Refuted,
}

/// How much of a card's `occurredAt` is meaningful. 'day' ignores the time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum DatePrecision {
  Day,
  #[default]
  Minute,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct EmailAddress {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub name: Option<String>,
  pub address: String,
}

/// An attachment carried with an imported message. `file` is where its bytes are
/// kept in the media library, absent only when keeping them failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
pub struct EmailAttachment {
  pub name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mime: Option<String>,
}

/// Where a card came from, when that changes what can be done with it. `mail-drag`
/// was dragged out of Apple Mail, which hands over the subject and Message-ID but
/// never the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum EmailSource {
  MailDrag,
}

/// Structured headers for an `email` card. The subject is the card's `title` and the
/// date its `occurredAt`, never a second copy here.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmailMeta {
  #[serde(default)]
  pub from: Option<EmailAddress>,
  #[serde(default)]
  pub to: Vec<EmailAddress>,
  #[serde(default)]
  pub cc: Vec<EmailAddress>,
  /// RFC 5322 Message-ID including angle brackets. Used to dedupe imports.
  #[serde(default)]
  pub message_id: Option<String>,
  #[serde(default)]
  pub in_reply_to: Option<String>,
  #[serde(default)]
  pub attachments: Vec<EmailAttachment>,
  /// The whole original .eml, kept in the media library.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub eml_file: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub source: Option<EmailSource>,
}

/// A text message: like an email, but addressed by phone number or handle, and
/// usually justified by a screenshot on the card's `imageFile`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct MessageMeta {
  #[serde(default)]
  pub from: Option<EmailAddress>,
  #[serde(default)]
  pub to: Vec<EmailAddress>,
  /// What was said, when it was typed in rather than only shown in a screenshot.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub body: Option<String>,
}

/// A phone call, justified by a screenshot of the call log and the notes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CallMeta {
  #[serde(default)]
  pub from: Option<EmailAddress>,
  #[serde(default)]
  pub to: Vec<EmailAddress>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub duration_secs: Option<f64>,
}

/// A person; the name is the card's `title`. Addresses and numbers are stored
/// normalised (`withAddress`, `withNumber`) because emails, texts and calls match on them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PersonMeta {
  #[serde(default)]
  pub addresses: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub numbers: Option<Vec<String>>,
}

/// An organisation: addresses of its own, and the domains (no leading '@') that make
/// person↔organisation derivable rather than hand-maintained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct OrgMeta {
  #[serde(default)]
  pub addresses: Vec<String>,
  #[serde(default)]
  pub domains: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub numbers: Option<Vec<String>>,
}

/// The file behind a `document` card and the properties read from it on import.
/// `created` is also copied to the card's `occurredAt`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
pub struct DocumentMeta {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mime: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub author: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub created: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub modified: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pages: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub words: Option<f64>,
}

/// An event spawned by "mark as event" points back at its source card, which is what
/// makes that checkbox derivable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct EventMeta {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_card_id: Option<String>,
}

/// A photo's EXIF, read on import. `takenAt` is also copied to the card's `occurredAt`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub width: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub height: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub taken_at: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub camera_make: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub camera_model: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub latitude: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub longitude: Option<f64>,
}

/// A crop over the source image as fractions of its natural size, 4:3 like the card,
/// so it maps to a pure-CSS transform (`cardImageStyle`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ImageCrop {
  pub x: f64,
  pub y: f64,
  pub w: f64,
  pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Card {
  pub id: String,
  pub title: String,
  /// Markdown notes / evidence for this card.
  #[serde(default)]
  pub notes: String,
  /// A remote picture URL; a local picture is `imageFile`. A legacy board may still
  /// carry a `data:` URL here until `migrateBoardMedia` moves it into the library.
  #[serde(default)]
  pub image_url: Option<String>,
  /// A local picture in the media library. Like every media reference it must be
  /// listed in `cardMediaEntries`, or `gcMedia` would sweep it as an orphan.
  #[serde(default)]
  pub image_file: Option<String>,
  /// How the picture is framed, or null for centre cover. Not a media reference.
  #[serde(default)]
  pub image_crop: Option<ImageCrop>,
  /// The picture's EXIF, or null. Not a media reference.
  #[serde(default)]
  pub image_meta: Option<ImageMeta>,
  /// The clusters this card belongs to, in order: the first is the primary, which
  /// drives the accent colour and Tidy's gravity. Replaced the single `clusterId` in v4.
  pub cluster_ids: Vec<String>,
  pub position: Vec2,
  #[serde(default)]
  pub kind: CardKind,
  /// When this card's event happened, as a UTC instant (always `…Z`), or null when
  /// undated. UTC makes string order chronological, and a day-precision value is
  /// stored at UTC midnight and must be rendered in UTC to stay on its day.
  #[serde(default)]
  pub occurred_at: Option<UtcInstant>,
  #[serde(default)]
  pub occurred_at_precision: DatePrecision,
  /// The payloads for the card's kind. One for a kind the card no longer is may
  /// linger, so email → person → email is a mis-click rather than lost headers:
  /// `kind` is the only authority, and every reader gates on it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub email: Option<EmailMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub message: Option<MessageMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub call: Option<CallMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub person: Option<PersonMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub organisation: Option<OrgMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub document: Option<DocumentMeta>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub event: Option<EventMeta>,
  /// Only meaningful for `event` and `evidence` (`isGradedKind`). Absent is ungraded.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub grade: Option<Grade>,
}

impl Card {
  /// Must list the same fields as `cardMediaEntries` (`src/lib/media.ts`): a field left
  /// out here has its file swept by `gc_media`.
  pub fn media_files(&self) -> impl Iterator<Item = &str> {
    let email = self.email.as_ref();
    self
      .image_file
      .iter()
      .chain(email.and_then(|e| e.eml_file.as_ref()))
      .chain(email.into_iter().flat_map(|e| e.attachments.iter().filter_map(|a| a.file.as_ref())))
      .chain(self.document.as_ref().and_then(|d| d.file.as_ref()))
      .map(String::as_str)
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
  #[default]
  RedString,
  Plain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Connection {
  pub id: String,
  pub source: String,
  pub target: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub label: Option<String>,
  #[serde(default)]
  pub kind: ConnectionKind,
  /// A link is a claim too, usually the weakest on the board, so it carries its own grade.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  #[cfg_attr(test, ts(optional))]
  pub grade: Option<Grade>,
}

/// A board from any version this build has written, migrated to the current one.
/// The version bump earns its keep on the way *out*: an older build refuses a newer
/// board whole rather than silently stripping what it doesn't know.
pub fn parse_board(mut board: Value) -> Result<Board, String> {
  let version = board.get("version").and_then(Value::as_f64);
  if !matches!(version, Some(v) if (1.0..=f64::from(BOARD_VERSION)).contains(&v) && v.fract() == 0.0) {
    return Err(format!("Not a board version this build can read: {:?}", board.get("version")));
  }
  board["version"] = json!(BOARD_VERSION);
  if let Some(cards) = board.get_mut("cards").and_then(Value::as_array_mut) {
    cards.iter_mut().for_each(migrate_card);
  }
  serde_json::from_value(board).map_err(|e| format!("Not a valid board: {e}"))
}

pub fn parse_board_json(text: &str) -> Result<Board, String> {
  parse_board(serde_json::from_str(text).map_err(|e| format!("Not a valid board: {e}"))?)
}

pub fn parse_card(mut card: Value) -> Result<Card, String> {
  migrate_card(&mut card);
  serde_json::from_value(card).map_err(|e| format!("Not a valid card: {e}"))
}

/// The field-shape changes since v1: a legacy `clusterId` widens to `clusterIds`
/// (which wins when both appear), and an attachment stored as a bare filename widens
/// to `{ name }`.
fn migrate_card(card: &mut Value) {
  let Some(card) = card.as_object_mut() else { return };
  let legacy = card.remove("clusterId");
  if !card.contains_key("clusterIds") {
    let ids: Vec<Value> = legacy.into_iter().filter(|id| id.as_str().is_some_and(|s| !s.is_empty())).collect();
    card.insert("clusterIds".into(), Value::Array(ids));
  }
  let attachments = card.get_mut("email").and_then(|e| e.get_mut("attachments")).and_then(Value::as_array_mut);
  for attachment in attachments.into_iter().flatten() {
    if let Value::String(name) = attachment {
      *attachment = json!({ "name": name });
    }
  }
}

/// `YYYY-MM-DDTHH:MM[:SS[.fff…]]Z` with a real calendar date — what every writer
/// produces through `Date#toISOString`, so an offset means data that bypassed it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UtcInstant(String);

impl UtcInstant {
  pub fn new(s: String) -> Option<Self> {
    is_utc_instant(&s).then_some(Self(s))
  }
}

impl<'de> Deserialize<'de> for UtcInstant {
  fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    let s = String::deserialize(d)?;
    Self::new(s.clone()).ok_or_else(|| serde::de::Error::custom(format!("not a UTC ISO-8601 instant: {s:?}")))
  }
}

fn is_utc_instant(s: &str) -> bool {
  let Some(body) = s.strip_suffix('Z') else { return false };
  let Some((date, time)) = body.split_once('T') else { return false };
  valid_date(date) && valid_time(time)
}

fn number(s: &str, len: usize) -> Option<u32> {
  (s.len() == len && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

fn valid_date(date: &str) -> bool {
  let mut parts = date.split('-');
  let (Some(y), Some(m), Some(d), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
    return false;
  };
  let (Some(y), Some(m), Some(d)) = (number(y, 4), number(m, 2), number(d, 2)) else { return false };
  let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
  let days = match m {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if leap => 29,
    2 => 28,
    _ => return false,
  };
  (1..=days).contains(&d)
}

fn valid_time(time: &str) -> bool {
  let (hms, fraction) = time.split_once('.').map_or((time, None), |(t, f)| (t, Some(f)));
  let mut parts = hms.split(':');
  let (Some(h), Some(m), seconds, None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
    return false;
  };
  let fraction_ok = match fraction {
    None => true,
    Some(f) => seconds.is_some() && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()),
  };
  number(h, 2).is_some_and(|h| h < 24)
    && number(m, 2).is_some_and(|m| m < 60)
    && seconds.map_or(true, |s| number(s, 2).is_some_and(|s| s < 60))
    && fraction_ok
}

#[cfg(test)]
mod tests;
