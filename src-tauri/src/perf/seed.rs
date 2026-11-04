//! A throwaway library shaped like a big real board, for the performance scenario
//! (`scripts/perf-scenario.mjs`). Deterministic: the same seed writes the same library.
//!
//!   CONSPIRACY_SEED_DIR=<dir> cargo test --lib seed_library -- --ignored

use std::path::Path;

use rusqlite::params;
use serde_json::{json, Value};

use crate::board_store::board_db::{create_listed_board, read_board_db};
use crate::board_store::media::{media_ext, media_name};
use crate::library_index::{open_at, ENGINE};
use crate::schema::parse_board;

pub(crate) struct Shape {
  pub emails: usize,
  pub board_cards: usize,
  pub clusters: usize,
  pub connections: usize,
}

/// Counts from the board the scenario stands in for.
pub(crate) const BIG_BOARD: Shape = Shape { emails: 10_953, board_cards: 73, clusters: 18, connections: 35 };

pub(crate) const BOARD_ID: &str = "brd_seeded";

/// splitmix64: small, seedable and good enough to scatter test data.
struct Rng(u64);

impl Rng {
  fn next(&mut self) -> u64 {
    self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = self.0;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
  }

  fn below(&mut self, n: usize) -> usize {
    (self.next() % n as u64) as usize
  }

  fn chance(&mut self, percent: u64) -> bool {
    self.next() % 100 < percent
  }

  fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
    items[self.below(items.len())]
  }
}

const FIRST: &[&str] = &[
  "Alice", "Ben", "Chloe", "Dev", "Ella", "Finn", "Grace", "Hamish", "Isla", "Jack", "Kiri", "Liam", "Mia", "Noah",
  "Olivia", "Priya", "Quinn", "Ruby", "Sam", "Tara", "Uma", "Vince", "Wren", "Xavier", "Yasmin", "Zac",
];
const LAST: &[&str] = &[
  "Abbott", "Brennan", "Chen", "Doyle", "Evans", "Fischer", "Gupta", "Hughes", "Ivanov", "Jones", "Kelly", "Lam",
  "Murphy", "Nguyen", "O'Brien", "Patel", "Quigley", "Ross", "Singh", "Turner", "Usman", "Vance", "Walsh", "Young",
];
const DOMAINS: &[&str] =
  &["example.com", "example.org", "council.example.gov.au", "law.example.com.au", "mail.example.net", "works.example"];
const SUBJECTS: &[&str] = &[
  "Tender documents", "Meeting minutes", "Re: site inspection", "Invoice query", "Planning approval", "Contract variation",
  "Follow-up on our call", "Board papers", "Draft report for review", "Licence renewal", "Re: Re: road works schedule",
  "Complaint lodged", "Freedom of information request", "Budget figures", "Agenda for Thursday",
];
const WORDS: &[&str] = &[
  "the", "council", "report", "meeting", "agreed", "contract", "tender", "please", "find", "attached", "regarding",
  "schedule", "approval", "budget", "minutes", "review", "draft", "works", "site", "road", "variation", "invoice",
  "committee", "decision", "we", "will", "should", "have", "not", "been", "provided", "with", "copy", "of", "and",
  "to", "on", "in", "for", "this", "that", "by", "next", "week", "as", "discussed", "regards", "thanks", "query",
];

const BOARD_KINDS: &[&str] = &["person", "person", "organisation", "event", "document", "evidence"];

fn person(rng: &mut Rng) -> (String, String) {
  let (first, last) = (rng.pick(FIRST), rng.pick(LAST));
  let address = format!("{}.{}@{}", first.to_lowercase(), last.to_lowercase().replace('\'', ""), rng.pick(DOMAINS));
  (format!("{first} {last}"), address)
}

fn prose(rng: &mut Rng, words: usize) -> String {
  let mut text = String::with_capacity(words * 7);
  for i in 0..words {
    text.push_str(rng.pick(WORDS));
    text.push_str(if i % 14 == 13 { ".\n" } else { " " });
  }
  text
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// A moment between 2015 and 2026, as a card's UTC instant and as an email `Date:` header.
fn instant(rng: &mut Rng) -> (String, String) {
  let (year, month, day) = (2015 + rng.below(12), rng.below(12), 1 + rng.below(28));
  let (hour, minute, second) = (rng.below(24), rng.below(60), rng.below(60));
  (
    format!("{year}-{:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z", month + 1),
    format!("{day} {} {year} {hour:02}:{minute:02}:{second:02} +0000", MONTHS[month]),
  )
}

/// An uncompressed 24-bit BMP, `w` by `h`, in two seeded colours.
fn picture(rng: &mut Rng, w: u32, h: u32) -> Vec<u8> {
  let row = (w * 3).div_ceil(4) * 4;
  let size = 54 + row * h;
  let mut out = Vec::with_capacity(size as usize);
  out.extend_from_slice(b"BM");
  for v in [size, 0, 54, 40] {
    out.extend_from_slice(&v.to_le_bytes());
  }
  out.extend_from_slice(&(w as i32).to_le_bytes());
  out.extend_from_slice(&(h as i32).to_le_bytes());
  out.extend_from_slice(&1u16.to_le_bytes());
  out.extend_from_slice(&24u16.to_le_bytes());
  for v in [0u32, row * h, 2835, 2835, 0, 0] {
    out.extend_from_slice(&v.to_le_bytes());
  }
  let colours = [rng.next().to_le_bytes(), rng.next().to_le_bytes()];
  for y in 0..h {
    for x in 0..w {
      out.extend_from_slice(&colours[((x / 16 + y / 16) % 2) as usize][..3]);
    }
    out.resize(out.len() + (row - w * 3) as usize, 0);
  }
  out
}

fn eml(from: &(String, String), to: &[(String, String)], subject: &str, date: &str, id: &str, body: &str) -> Vec<u8> {
  let to: Vec<String> = to.iter().map(|(n, a)| format!("{n} <{a}>")).collect();
  format!(
    "From: {} <{}>\r\nTo: {}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}",
    from.0,
    from.1,
    to.join(", ")
  )
  .into_bytes()
}

fn address((name, address): &(String, String)) -> Value {
  json!({ "name": name, "address": address })
}

/// Writes `boards/`, `media/`, `Inbox/` and `library.sqlite` under `dir`, which must not hold a board yet.
pub(crate) fn seed_library(dir: &Path, shape: &Shape, seed: u64) -> Result<(), String> {
  let mut rng = Rng(seed);
  let media = dir.join("media");
  let boards = dir.join("boards");
  for d in [&media, &boards, &dir.join("Inbox")] {
    std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
  }
  let library = open_at(dir)?;
  let mut kept: Vec<(String, Vec<u8>)> = Vec::new();
  let mut keep = |bytes: Vec<u8>, ext: &str| -> Result<String, String> {
    // Not `keep_media_in`: its fsync per file would make eleven thousand of them take minutes.
    let name = media_name(&bytes, ext);
    std::fs::write(media.join(&name), &bytes).map_err(|e| format!("{name}: {e}"))?;
    kept.push((name.clone(), bytes));
    Ok(name)
  };

  let clusters: Vec<Value> = (0..shape.clusters)
    .map(|i| json!({ "id": format!("cl_{i:08}"), "label": format!("Thread {}", i + 1), "color": format!("#{:06x}", rng.next() & 0xff_ffff), "visible": true }))
    .collect();
  let cluster_id = |rng: &mut Rng| format!("cl_{:08}", rng.below(shape.clusters.max(1)));

  let mut cards = Vec::with_capacity(shape.emails + shape.board_cards);
  for i in 0..shape.board_cards {
    let kind = rng.pick(BOARD_KINDS);
    let (name, address) = person(&mut rng);
    let mut card = json!({
      "id": format!("card_b{i:07}"),
      "title": if kind == "person" { name } else { format!("{} {}", rng.pick(SUBJECTS), i + 1) },
      "notes": if rng.chance(30) { prose(&mut rng, 30) } else { String::new() },
      "clusterIds": if rng.chance(60) { vec![cluster_id(&mut rng)] } else { vec![] },
      "position": { "x": -3800.0 + rng.below(10_300) as f64, "y": -3800.0 + rng.below(2_200) as f64 },
      "kind": kind,
      "occurredAt": if matches!(kind, "event" | "evidence" | "document") { json!(instant(&mut rng).0) } else { Value::Null },
    });
    if kind == "person" {
      card["person"] = json!({ "addresses": [address] });
    }
    if rng.chance(15) {
      card["imageFile"] = json!(keep(picture(&mut rng, 160, 120), "bmp")?);
    }
    cards.push(card);
  }

  for i in 0..shape.emails {
    let from = person(&mut rng);
    let to: Vec<_> = (0..1 + rng.below(2)).map(|_| person(&mut rng)).collect();
    let cc: Vec<_> = (0..rng.below(3)).map(|_| person(&mut rng)).collect();
    let subject = rng.pick(SUBJECTS);
    let (occurred_at, date) = instant(&mut rng);
    let message_id = format!("{i}.{:x}@{}", rng.next(), rng.pick(DOMAINS));
    let words = 150 + rng.below(700);
    let body = prose(&mut rng, words);
    let eml_file = keep(eml(&from, &to, subject, &date, &message_id, &body), "eml")?;
    let mut attachments = Vec::new();
    if rng.chance(13) {
      let file = keep(prose(&mut rng, 80).into_bytes(), "txt")?;
      attachments.push(json!({ "name": format!("attachment-{i}.txt"), "file": file, "mime": "text/plain" }));
    }
    let mut card = json!({
      "id": format!("card_e{i:07}"),
      "title": subject,
      "notes": body,
      "clusterIds": if rng.chance(1) { vec![cluster_id(&mut rng)] } else { vec![] },
      "position": { "x": 0.0, "y": 0.0 },
      "kind": "email",
      "occurredAt": occurred_at,
      "email": {
        "from": address(&from),
        "to": to.iter().map(address).collect::<Vec<_>>(),
        "cc": cc.iter().map(address).collect::<Vec<_>>(),
        "messageId": message_id,
        "attachments": attachments,
        "emlFile": eml_file,
      },
    });
    if rng.chance(2) {
      card["imageFile"] = json!(keep(picture(&mut rng, 320, 240), "bmp")?);
    }
    cards.push(card);
  }

  let connections: Vec<Value> = (0..shape.connections.min(shape.board_cards.saturating_sub(1) * 2))
    .map(|i| {
      let source = rng.below(shape.board_cards);
      let target = (source + 1 + rng.below(shape.board_cards - 1)) % shape.board_cards;
      json!({ "id": format!("edge_{i:08}"), "source": format!("card_b{source:07}"), "target": format!("card_b{target:07}") })
    })
    .collect();

  let board = parse_board(json!({
    "version": 1,
    "meta": { "title": "Seeded big board", "updatedAt": "2026-11-04T00:00:00.000Z" },
    "clusters": clusters,
    "cards": cards,
    "connections": connections,
  }))?;
  create_listed_board(&boards, &library, BOARD_ID, &board)?;

  let mut conn = library.lock_db()?;
  let tx = conn.transaction().map_err(|e| e.to_string())?;
  {
    // Not `write_outcome`: its delete scans the whole full-text table, once per file.
    let mut document = tx
      .prepare("INSERT INTO documents(name, size, status, engine, attempts) VALUES(?1, ?2, 'indexed', ?3, 0)")
      .map_err(|e| e.to_string())?;
    let mut text = tx.prepare("INSERT INTO doc_fts(name, body) VALUES(?1, ?2)").map_err(|e| e.to_string())?;
    for (name, bytes) in &kept {
      document.execute(params![name, bytes.len() as i64, ENGINE]).map_err(|e| e.to_string())?;
      if media_ext(name) != "bmp" {
        text.execute(params![name, String::from_utf8_lossy(bytes)]).map_err(|e| e.to_string())?;
      }
    }
  }
  tx.commit().map_err(|e| e.to_string())
}

#[test]
#[ignore = "writes a library for the performance scenario; run it by name"]
fn seed_library_for_the_scenario() {
  let dir = std::env::var_os("CONSPIRACY_SEED_DIR").expect("CONSPIRACY_SEED_DIR names the library to write");
  seed_library(Path::new(&dir), &BIG_BOARD, 11).unwrap();
}

const SMALL: Shape = Shape { emails: 120, board_cards: 12, clusters: 3, connections: 6 };

fn seeded(name: &str) -> (std::path::PathBuf, crate::schema::Board) {
  let dir = crate::board_store::temp_dir_for(name);
  seed_library(&dir, &SMALL, 7).unwrap();
  let board = read_board_db(&dir.join("boards").join(format!("{BOARD_ID}.sqlite"))).unwrap();
  (dir, board)
}

#[test]
fn a_seeded_library_holds_the_shape_asked_for_with_its_media_indexed() {
  let (dir, board) = seeded("seed-shape");
  let emails = board.cards.iter().filter(|c| c.kind == crate::schema::CardKind::Email).count();
  assert_eq!((emails, board.cards.len(), board.clusters.len(), board.connections.len()), (120, 132, 3, 6));
  let media = std::fs::read_dir(dir.join("media")).unwrap().count();
  let conn = open_at(&dir).unwrap();
  let indexed: usize =
    conn.lock_db().unwrap().query_row("SELECT count(*) FROM documents", [], |r| r.get(0)).unwrap();
  assert_eq!(indexed, media);
  assert!(board.cards.iter().flat_map(|c| c.media_files()).all(|m| dir.join("media").join(m).exists()));
  let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_same_seed_writes_the_same_board() {
  let (a_dir, a) = seeded("seed-a");
  let (b_dir, b) = seeded("seed-b");
  assert_eq!(a.cards, b.cards);
  for dir in [a_dir, b_dir] {
    let _ = std::fs::remove_dir_all(&dir);
  }
}
