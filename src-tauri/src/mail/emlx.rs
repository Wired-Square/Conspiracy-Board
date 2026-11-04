//! Apple Mail's `.emlx`: a line giving the message's length in bytes, the RFC 822
//! message, then a plist of Mail's flags. A `.partial.emlx` has the same shape, with
//! its attachments left out.

pub fn is_emlx(name: &str) -> bool {
  name.to_ascii_lowercase().ends_with(".emlx")
}

/// The message, or as much of it as the file holds.
pub fn message(bytes: &[u8]) -> Option<&[u8]> {
  let newline = bytes.iter().position(|&b| b == b'\n')?;
  let len: usize = std::str::from_utf8(&bytes[..newline]).ok()?.trim().parse().ok()?;
  let rest = &bytes[newline + 1..];
  Some(&rest[..len.min(rest.len())])
}
