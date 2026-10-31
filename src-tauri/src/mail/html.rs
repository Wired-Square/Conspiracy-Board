//! An HTML email body as the markdown-ish plain text a card's `notes` hold:
//! paragraphs and list items on their own lines, headings as `#`, links as
//! `[text](href)`. Never rendered as HTML, so untrusted markup goes no further.

const BLOCK: &[&str] = &[
  "p", "div", "tr", "br", "li", "ul", "ol", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "section", "article", "header", "footer",
];
/// Elements whose content is never text: raw text runs to the closing tag.
const RAW: &[&str] = &["script", "style", "title", "textarea"];
const HIDDEN: &[&str] = &["head", "noscript"];

struct Tag<'a> {
  name: String,
  closing: bool,
  attrs: &'a str,
}

/// The tag at the start of `s` (which begins with `<`), and the bytes it spans.
fn tag(s: &str) -> Option<(Tag<'_>, usize)> {
  let inner = &s[1..];
  let closing = inner.starts_with('/');
  let inner = if closing { &inner[1..] } else { inner };
  let name_len = inner.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(inner.len());
  if name_len == 0 {
    return None;
  }
  let mut quote = None;
  let end = inner.char_indices().find_map(|(i, c)| match (quote, c) {
    (None, '"' | '\'') => {
      quote = Some(c);
      None
    }
    (Some(q), c) if c == q => {
      quote = None;
      None
    }
    (None, '>') => Some(i),
    _ => None,
  })?;
  let name = inner[..name_len].to_ascii_lowercase();
  let consumed = 1 + usize::from(closing) + end + 1;
  Some((Tag { name, closing, attrs: &inner[name_len..end] }, consumed))
}

fn attr(attrs: &str, name: &str) -> Option<String> {
  let lower = attrs.to_ascii_lowercase();
  let mut from = 0;
  while let Some(at) = lower[from..].find(name).map(|i| i + from) {
    from = at + name.len();
    let boundary = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
    let rest = attrs[from..].trim_start();
    let Some(value) = rest.strip_prefix('=').filter(|_| boundary).map(str::trim_start) else { continue };
    let raw = match value.chars().next() {
      Some(q @ ('"' | '\'')) => value[1..].split(q).next().unwrap_or(""),
      _ => value.split(|c: char| c.is_ascii_whitespace() || c == '>').next().unwrap_or(""),
    };
    return Some(decode_entities(raw));
  }
  None
}

fn decode_entities(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut rest = s;
  while let Some(amp) = rest.find('&') {
    out.push_str(&rest[..amp]);
    rest = &rest[amp..];
    let end = rest[1..].find(|c: char| c == ';' || c == '&' || c.is_whitespace()).map(|i| i + 1);
    match end.filter(|&i| rest.as_bytes()[i] == b';') {
      Some(semi) => {
        mail_parser::add_html_token(&mut out, rest[..=semi].as_bytes(), false);
        rest = &rest[semi + 1..];
      }
      None => {
        out.push('&');
        rest = &rest[1..];
      }
    }
  }
  out.push_str(rest);
  out
}

fn collapse(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for (i, word) in s.split(|c: char| c.is_whitespace()).enumerate() {
    if i > 0 && !out.ends_with(' ') {
      out.push(' ');
    }
    out.push_str(word);
  }
  out
}

/// An open `<a>`: its href and the text inside it so far.
struct Link {
  href: Option<String>,
  text: String,
}

pub fn html_to_text(html: &str) -> String {
  let mut out = String::new();
  let mut hidden = 0usize;
  let mut link: Option<Link> = None;
  let mut rest = html;
  while !rest.is_empty() {
    let lt = rest.find('<').unwrap_or(rest.len());
    if hidden == 0 && lt > 0 {
      let text = collapse(&decode_entities(&rest[..lt]));
      match &mut link {
        Some(link) => link.text.push_str(&text),
        None => out.push_str(&text),
      }
    }
    rest = &rest[lt..];
    if rest.is_empty() {
      break;
    }
    if let Some(comment) = rest.strip_prefix("<!--") {
      rest = comment.find("-->").map_or("", |i| &comment[i + 3..]);
      continue;
    }
    let Some((tag, consumed)) = tag(rest) else {
      // A `<` that opens no tag, or a declaration like `<!DOCTYPE`, is skipped whole.
      rest = rest.find('>').map_or("", |i| &rest[i + 1..]);
      continue;
    };
    rest = &rest[consumed..];
    let name = tag.name.as_str();
    if RAW.contains(&name) && !tag.closing {
      let close = format!("</{name}");
      rest = rest.to_ascii_lowercase().find(&close).map_or("", |i| &rest[i..]);
      continue;
    }
    if HIDDEN.contains(&name) {
      hidden = if tag.closing { hidden.saturating_sub(1) } else { hidden + 1 };
      continue;
    }
    if hidden > 0 {
      continue;
    }
    if name == "a" {
      if tag.closing {
        if let Some(Link { href, text }) = link.take() {
          let text = text.trim();
          match href {
            Some(href) if !text.is_empty() && href != text && !href.starts_with("mailto:") => {
              out.push_str(&format!("[{text}]({href})"))
            }
            _ => out.push_str(text),
          }
        }
      } else if link.is_none() {
        link = Some(Link { href: attr(tag.attrs, "href").map(|h| h.trim().to_string()).filter(|h| !h.is_empty()), text: String::new() });
      }
      continue;
    }
    if link.is_some() {
      continue;
    }
    match (name, tag.closing) {
      ("br", false) => out.push('\n'),
      ("hr", false) => out.push_str("\n---\n"),
      (_, closing) if BLOCK.contains(&name) => {
        out.push('\n');
        if !closing {
          if let Some(level) = name.strip_prefix('h').and_then(|n| n.parse::<usize>().ok()) {
            out.push_str(&"#".repeat(level));
            out.push(' ');
          }
          if name == "li" {
            out.push_str("- ");
          }
        }
      }
      _ => {}
    }
  }
  tidy(&out)
}

/// Runs of spaces to one, no spaces around a line break, and at most one blank line.
fn tidy(text: &str) -> String {
  let lines: Vec<String> = text.split('\n').map(|line| collapse(&line.replace('\t', " ")).trim().to_string()).collect();
  let mut out = String::with_capacity(text.len());
  let mut blank = 0;
  for line in &lines {
    if line.is_empty() {
      blank += 1;
      if blank <= 1 {
        out.push('\n');
      }
    } else {
      blank = 0;
      out.push_str(line);
      out.push('\n');
    }
  }
  out.trim().to_string()
}
