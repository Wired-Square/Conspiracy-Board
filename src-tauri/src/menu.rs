//! The native application menu — a "File" menu for managing boards.
//!
//! The webview owns the board list (the schema is TypeScript's, see board_store),
//! so it hands the shell a flat `[{id, title}]` whenever the library changes and
//! the shell rebuilds the menu around it. Clicking an item emits `menu:board`,
//! which the webview listens for (`src/platform/boardMenu.ts`) and turns into a
//! store call — the same emit/listen bridge the Apple Mail drop uses. Nothing
//! here parses a board; the shell only lists and dispatches.

use serde::{Deserialize, Serialize};
use tauri::menu::{
  CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Wry};

/// A board as the menu needs it — enough to list it and to open it. Sent by the
/// webview, which is the one that knows the library.
#[derive(Deserialize)]
pub struct BoardEntry {
  id: String,
  title: String,
}

/// What a menu click tells the webview. `id` is set only for "open".
#[derive(Clone, Serialize)]
struct BoardMenuEvent {
  action: String,
  id: Option<String>,
}

/// A View-menu click: which surface to switch to (the store's View value).
#[derive(Clone, Serialize)]
struct ViewMenuEvent {
  view: String,
}

/// Board-open items carry their board id in the menu id, since a MenuEvent hands
/// back only an id. Everything after the prefix is the board id.
const OPEN_PREFIX: &str = "board.open.";

/// The File submenu, built around the current library.
fn file_submenu(
  app: &AppHandle,
  boards: &[BoardEntry],
  current: Option<&str>,
) -> tauri::Result<Submenu<Wry>> {
  let mut open = SubmenuBuilder::new(app, "Open Board");
  if boards.is_empty() {
    open = open.item(&MenuItem::with_id(app, "board.none", "No boards yet", false, None::<&str>)?);
  } else {
    for board in boards {
      let label = if board.title.is_empty() { "Untitled board" } else { &board.title };
      let checked = current == Some(board.id.as_str());
      let item =
        CheckMenuItem::with_id(app, format!("{OPEN_PREFIX}{}", board.id), label, true, checked, None::<&str>)?;
      open = open.item(&item);
    }
  }
  let open = open.build()?;

  SubmenuBuilder::new(app, "File")
    .item(&MenuItem::with_id(app, "board.new", "New Board", true, Some("CmdOrCtrl+N"))?)
    .item(&open)
    .separator()
    // Manage (rename / delete / reveal) and Properties are the two things you do
    // *to* the open board, so they sit together.
    .item(&MenuItem::with_id(app, "board.manage", "Manage", true, None::<&str>)?)
    .item(&MenuItem::with_id(app, "board.properties", "Board Properties", true, None::<&str>)?)
    .separator()
    .item(&MenuItem::with_id(app, "board.import", "Import Bundle", true, None::<&str>)?)
    .item(&MenuItem::with_id(app, "board.export", "Export Bundle", true, None::<&str>)?)
    .separator()
    .item(&MenuItem::with_id(app, "inbox.reveal", "Show Inbox Folder", true, None::<&str>)?)
    .separator()
    // Keep the one item the stock File menu had, since we replace it wholesale.
    .item(&PredefinedMenuItem::close_window(app, None)?)
    .build()
}

/// The three surfaces, as (menu id, label, the View value the webview uses). The
/// label and the value are kept apart here (the label is title-case for the menu,
/// the value is the `View` string). The labels mirror `VIEW_META` in
/// `src/types/view.ts` — the one place they can't share, being across the process
/// boundary; the value is what a click sends back over `menu:view`.
const VIEWS: [(&str, &str, &str); 3] = [
  ("view.board", "Board", "board"),
  ("view.record", "Record", "record"),
  ("view.objects", "Objects", "object"),
];

/// The View submenu — the three surfaces as checkmarks (the current one ticked),
/// then the stock Enter Full Screen kept from the menu we replace.
fn view_submenu(app: &AppHandle, view: &str) -> tauri::Result<Submenu<Wry>> {
  let mut builder = SubmenuBuilder::new(app, "View");
  for (id, label, value) in VIEWS {
    let item = CheckMenuItem::with_id(app, id, label, true, view == value, None::<&str>)?;
    builder = builder.item(&item);
  }
  builder.separator().item(&PredefinedMenuItem::fullscreen(app, None)?).build()
}

/// The whole app menu: the stock macOS menu (App / Edit / Window, Quit, Copy &
/// Paste …) with its File and View submenus swapped for ours. `Menu::default`
/// already ships both, so we replace rather than insert — otherwise the bar shows
/// two of each. File goes back at index 1 and View at 3, their stock positions.
fn build_menu(
  app: &AppHandle,
  boards: &[BoardEntry],
  current: Option<&str>,
  view: &str,
) -> tauri::Result<Menu<Wry>> {
  let menu = Menu::default(app)?;
  for item in menu.items()? {
    if let MenuItemKind::Submenu(sub) = &item {
      if sub.text().map(|t| t == "File" || t == "View").unwrap_or(false) {
        menu.remove(sub)?;
      }
    }
  }
  menu.insert(&file_submenu(app, boards, current)?, 1)?;
  menu.insert(&view_submenu(app, view)?, 3)?;
  Ok(menu)
}

/// Install the initial menu at startup, before the webview has mounted to send a
/// real board list — so the menus are there from the first frame. The view starts
/// on the board, matching the store's default.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
  app.set_menu(build_menu(app, &[], None, "board")?)?;
  Ok(())
}

/// Rebuild the menu around the current library and view. The webview calls this
/// after any change to the board list, the current board, or the current view.
#[tauri::command]
pub fn set_board_menu(
  app: AppHandle,
  boards: Vec<BoardEntry>,
  current_id: Option<String>,
  view: String,
) -> Result<(), String> {
  let menu = build_menu(&app, &boards, current_id.as_deref(), &view)
    .map_err(|e| format!("Could not build the menu: {e}"))?;
  app.set_menu(menu).map_err(|e| format!("Could not set the menu: {e}"))?;
  Ok(())
}

/// Turn a menu click into a `menu:board` event for the webview. Predefined items
/// (Quit, Copy, …) and the empty-list placeholder fall through to nothing.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
  let id = event.id().as_ref();
  // The Inbox reveal needs nothing from the webview — the folder is a fixed path —
  // so the shell handles it directly rather than round-tripping an event.
  if id == "inbox.reveal" {
    if let Err(e) = crate::board_store::open_inbox(app) {
      log::warn!("Could not show the Inbox: {e}");
    }
    return;
  }
  // A View-menu click switches the surface — its own event, since it drives the
  // store's view rather than the board library.
  if let Some((_, _, value)) = VIEWS.iter().find(|(vid, _, _)| *vid == id) {
    let _ = app.emit("menu:view", ViewMenuEvent { view: (*value).to_string() });
    return;
  }
  let evt = if let Some(board_id) = id.strip_prefix(OPEN_PREFIX) {
    BoardMenuEvent { action: "open".into(), id: Some(board_id.to_string()) }
  } else {
    let action = match id {
      "board.new" => "new",
      "board.manage" => "manage",
      "board.import" => "import",
      "board.export" => "export",
      "board.properties" => "properties",
      _ => return,
    };
    BoardMenuEvent { action: action.into(), id: None }
  };
  let _ = app.emit("menu:board", evt);
}
