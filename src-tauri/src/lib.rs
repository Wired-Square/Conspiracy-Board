#[cfg(test)]
mod bindings;
mod board_store;
mod extract;
mod file_types;
mod jobs;
mod library_index;
mod mail;
#[cfg(feature = "mcp")]
mod mcp;
mod menu;
mod quit;
mod schema;

#[cfg(all(feature = "mcp", not(debug_assertions)))]
compile_error!("the `mcp` feature is for development builds only");

#[cfg(target_os = "macos")]
mod ocr;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // The native open and save panels for a bundle, which the shell reads and
    // writes by path so a large `.zip` never crosses IPC.
    .plugin(tauri_plugin_dialog::init())
    .manage(quit::Busy::default())
    .plugin(wslib_tauri::quit_guard::init(quit::is_busy))
    .invoke_handler(tauri::generate_handler![
      board_store::init_storage,
      board_store::board_index::list_boards,
      board_store::board_index::current_board_id,
      board_store::board_index::set_current_board_id,
      board_store::board_db::load_board,
      board_store::board_db::seed_board,
      board_store::board_db::save_board,
      board_store::board_db::retire_legacy_board,
      board_store::board_db::delete_board,
      board_store::board_db::board_location,
      board_store::board_db::reveal_board,
      board_store::board_db::record_media_refs,
      board_store::board_db::media_refs,
      board_store::media::media_dir_path,
      board_store::media::save_media,
      board_store::media::download_image,
      board_store::media::read_media,
      board_store::media::extract_media_meta,
      board_store::media::ocr_image,
      board_store::media::gc_media,
      board_store::media::open_media,
      board_store::media::list_media,
      board_store::media::verify_media,
      board_store::media::open_media_dir,
      board_store::bundle::write_bundle,
      board_store::bundle::read_bundle,
      mail::parse_email_files,
      mail::parse_email_text,
      mail::recover_email_attachments,
      library_index::search_documents,
      library_index::reindex_media,
      library_index::reindex_all,
      library_index::jobs_pending,
      library_index::index_statuses,
      menu::set_board_menu,
      quit::set_busy,
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
      app.manage(library_index::start_worker(app.handle()));

      // Watch the Inbox drop-folder — the one automatic way in. Mail dragged to
      // Finder becomes one .eml per message, which this hands to the importer;
      // images and documents dropped there import the same way.
      board_store::inbox::start_inbox_watcher(app.handle().clone());

      #[cfg(feature = "mcp")]
      mcp::start(app.handle());

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
