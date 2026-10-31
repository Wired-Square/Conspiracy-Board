//! File-type rules.

/// An extension for storing a file under: the name's if it has one, else the media
/// type's subtype, else `bin`. `media_name` sanitises it further.
pub fn ext_of(name: Option<&str>, mime: Option<&str>) -> String {
  let from_name = name.and_then(|n| n.rfind('.').filter(|&dot| dot > 0).map(|dot| &n[dot + 1..]));
  let from_mime = || mime?.split('/').nth(1)?.split([';', '+']).next();
  from_name.filter(|e| !e.is_empty()).or_else(from_mime).filter(|e| !e.is_empty()).unwrap_or("bin").to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ext_of_prefers_the_name_then_the_media_type() {
    assert_eq!(ext_of(Some("photo.PNG"), Some("image/jpeg")), "PNG");
    assert_eq!(ext_of(Some("README"), Some("image/svg+xml")), "svg");
    assert_eq!(ext_of(None, Some("text/plain; charset=utf-8")), "plain");
    assert_eq!(ext_of(Some(".hidden"), None), "bin");
    assert_eq!(ext_of(None, None), "bin");
  }
}
