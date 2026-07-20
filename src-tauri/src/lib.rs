mod board_store;
mod extract;
mod library_index;
mod menu;

#[cfg(target_os = "macos")]
mod ocr;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // The native save panel for "Export Bundle…", so the user chooses where the
    // `.zip` lands. The only plugin here: a save location is a thing the webview
    // genuinely cannot ask for, where the file picker and download it still owns are.
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      board_store::init_storage,
      board_store::load_index,
      board_store::save_index,
      board_store::load_board,
      board_store::save_board,
      board_store::retire_legacy_board,
      board_store::delete_board,
      board_store::board_location,
      board_store::reveal_board,
      board_store::media_dir_path,
      board_store::save_media,
      board_store::fetch_image,
      board_store::read_media,
      board_store::extract_media_meta,
      board_store::ocr_image,
      board_store::gc_media,
      board_store::open_media,
      board_store::list_media,
      board_store::verify_media,
      board_store::open_media_dir,
      board_store::write_bundle,
      board_store::read_bundle,
      library_index::process_media,
      library_index::search_documents,
      library_index::pending_media,
      library_index::prune_documents,
      library_index::rebuild_index,
      library_index::index_statuses,
      menu::set_board_menu,
    ])
    .on_menu_event(menu::on_event)
    .setup(|app| {
      use tauri::Manager;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            // lopdf logs a WARN per embedded font whose ToUnicode map it can't parse
            // while extracting a PDF's text (extract.rs). It recovers — standard
            // encoding as a fallback — and still indexes the text, so these are noise
            // that would otherwise bury every real log line; keep only its errors.
            .level_for("lopdf", log::LevelFilter::Error)
            .build(),
        )?;
      }

      // A native File menu for board management; the webview repopulates its
      // board submenu on mount (src/platform/boardMenu.ts).
      menu::install(app.handle())?;

      // Open the library-wide search index (library.sqlite) and hold its one
      // connection in app state, for the extraction and search commands. A failure
      // here is fatal to startup — the index is created if absent, so this only fails
      // if the library directory itself is unwritable.
      match library_index::open(app.handle()) {
        Ok(db) => {
          app.manage(db);
        }
        Err(e) => return Err(e.into()),
      }

      // Watch the Inbox drop-folder — the one automatic way in. Mail dragged to
      // Finder becomes one .eml per message, which this hands to the importer;
      // images and documents dropped there import the same way.
      board_store::start_inbox_watcher(app.handle().clone());

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
