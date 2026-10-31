//! The webview's types, generated from these Rust ones by ts-rs and committed under
//! `src/bindings/`. The test fails while the committed files are stale;
//! `UPDATE_BINDINGS=1 cargo test bindings` rewrites them.

use std::path::{Path, PathBuf};

use ts_rs::TS;

fn export_all(dir: &Path) -> Result<(), ts_rs::ExportError> {
  crate::schema::Board::export_all_to(dir)?;
  crate::board_store::board_db::LoadedBoard::export_all_to(dir)?;
  crate::board_store::board_db::SaveBoardPayload::export_all_to(dir)?;
  crate::board_store::board_db::LibraryRefs::export_all_to(dir)?;
  crate::board_store::board_index::BoardSummary::export_all_to(dir)?;
  crate::board_store::bundle::BundleManifest::export_all_to(dir)?;
  crate::board_store::media::GcOutcome::export_all_to(dir)?;
  crate::board_store::media::MediaEntry::export_all_to(dir)?;
  crate::extract::meta::MediaMeta::export_all_to(dir)?;
  crate::library_index::DocHit::export_all_to(dir)?;
  crate::library_index::DocStatus::export_all_to(dir)
}

fn ts_files(dir: &Path) -> Vec<(String, String)> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut files: Vec<_> = entries
    .flatten()
    .map(|e| e.path())
    .filter(|p| p.extension().is_some_and(|x| x == "ts"))
    .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&p).unwrap()))
    .collect();
  files.sort();
  files
}

#[test]
fn generated_bindings_are_current() {
  let committed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings");
  let fresh = std::env::temp_dir().join(format!("conspiracy-bindings-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&fresh);
  export_all(&fresh).unwrap();
  let generated = ts_files(&fresh);

  if std::env::var_os("UPDATE_BINDINGS").is_some() {
    let _ = std::fs::remove_dir_all(&committed);
    std::fs::create_dir_all(&committed).unwrap();
    for (name, text) in &generated {
      std::fs::write(committed.join(name), text).unwrap();
    }
  } else {
    let on_disk = ts_files(&committed);
    let stale: std::collections::BTreeSet<&str> = on_disk
      .iter()
      .chain(&generated)
      .filter(|file| !(on_disk.contains(file) && generated.contains(file)))
      .map(|(name, _)| name.as_str())
      .collect();
    assert!(stale.is_empty(), "src/bindings is stale ({stale:?}); run `UPDATE_BINDINGS=1 cargo test bindings`");
  }
  let _ = std::fs::remove_dir_all(&fresh);
}
