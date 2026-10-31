//! An mbox is messages concatenated with a "From " (From_) separator line, split
//! here on raw bytes so each message keeps its own charset for the parser.
//!
//! A line starting "From " is not enough: a body line can, and the line before a
//! body's first line is always blank. A real From_ line is
//! `From <sender> <ctime date>`, so the weekday and month are what tell it from prose.

fn is_from_line(line: &[u8]) -> bool {
  let Some(rest) = line.strip_prefix(b"From ") else { return false };
  let sender = rest.iter().take_while(|b| !b.is_ascii_whitespace()).count();
  if sender == 0 {
    return false;
  }
  let mut rest = &rest[sender..];
  // The weekday, then the month.
  for _ in 0..2 {
    let gap = spaces(rest);
    if gap == 0 || rest.len() < gap + 3 || !capitalised_triple(&rest[gap..gap + 3]) {
      return false;
    }
    rest = &rest[gap + 3..];
  }
  let gap = spaces(rest);
  let digits = rest[gap..].iter().take_while(|b| b.is_ascii_digit()).count();
  gap > 0 && (1..=2).contains(&digits) && rest.get(gap + digits) == Some(&b' ')
}

fn spaces(s: &[u8]) -> usize {
  s.iter().take_while(|&&b| b == b' ').count()
}

fn capitalised_triple(w: &[u8]) -> bool {
  w[0].is_ascii_uppercase() && w[1].is_ascii_lowercase() && w[2].is_ascii_lowercase()
}

/// Whether the bytes start like an mbox rather than a single message.
pub fn looks_like_mbox(bytes: &[u8]) -> bool {
  let first = bytes.split(|&b| b == b'\n').next().unwrap_or_default();
  is_from_line(first.strip_suffix(b"\r").unwrap_or(first))
}

/// The raw messages of an mbox, with mboxrd's `>From ` quoting undone one level.
pub fn split_mbox(bytes: &[u8]) -> Vec<Vec<u8>> {
  let mut messages = Vec::new();
  let mut current: Option<Vec<u8>> = None;
  // Start-of-file counts as a separator boundary.
  let mut prev_blank = true;
  for line in bytes.split(|&b| b == b'\n') {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if prev_blank && is_from_line(line) {
      messages.extend(current.replace(Vec::new()));
    } else if let Some(message) = &mut current {
      let quoted = line.iter().take_while(|&&b| b == b'>').count();
      let line = if quoted > 0 && line[quoted..].starts_with(b"From ") { &line[1..] } else { line };
      message.extend_from_slice(line);
      message.push(b'\n');
    }
    prev_blank = line.trim_ascii().is_empty();
  }
  messages.extend(current);
  messages.into_iter().map(|m| m.trim_ascii().to_vec()).filter(|m| !m.is_empty()).collect()
}
