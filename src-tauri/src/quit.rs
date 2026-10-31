//! Whether the webview has a save pending or in flight, which
//! `wslib_tauri::quit_guard` holds a quit for. The webview reports it with
//! `set_busy` and flushes its pending autosave on `quit-pending`.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct Busy(AtomicBool);

#[tauri::command]
pub fn set_busy(state: State<Busy>, busy: bool) {
  state.0.store(busy, Ordering::SeqCst);
}

pub fn is_busy(app: &AppHandle) -> bool {
  app.state::<Busy>().0.load(Ordering::SeqCst)
}
