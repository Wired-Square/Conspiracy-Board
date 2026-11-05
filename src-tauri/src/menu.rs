//! The native application menu — a "File" menu for managing boards.
//!
//! The webview holds the board list it shows, so it hands the shell a flat
//! `[{id, title}]` whenever the library changes and
//! the shell rebuilds the menu around it. Clicking an item emits `menu:board`,
//! which the webview listens for (`src/platform/boardMenu.ts`) and turns into a
//! store call — the same emit/listen bridge the Apple Mail drop uses. Nothing
//! here parses a board; the shell only lists and dispatches.

use serde::{Deserialize, Serialize};
use tauri::menu::{
  AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
  HELP_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Wry};
#[cfg(target_os = "macos")]
use wslib_tauri::quit_guard::QUIT_MENU_ID;

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
    .item(&MenuItem::with_id(app, "library.mcp", "Library MCP…", true, None::<&str>)?)
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

/// The webview's two mask controls, as the View menu ticks them.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskMenu {
  mask: bool,
  show_masked: bool,
}

const MASK_ITEM: &str = "view.mask";
const SHOW_MASKED_ITEM: &str = "view.showMasked";

/// The View submenu — the three surfaces as checkmarks (the current one ticked),
/// the mask controls, then the stock Enter Full Screen kept from the menu we replace.
fn view_submenu(app: &AppHandle, view: &str, mask: MaskMenu) -> tauri::Result<Submenu<Wry>> {
  let mut builder = SubmenuBuilder::new(app, "View");
  for (id, label, value) in VIEWS {
    let item = CheckMenuItem::with_id(app, id, label, true, view == value, None::<&str>)?;
    builder = builder.item(&item);
  }
  builder
    .separator()
    .item(&CheckMenuItem::with_id(app, MASK_ITEM, "Mask Confidential", true, mask.mask, None::<&str>)?)
    .item(&CheckMenuItem::with_id(app, SHOW_MASKED_ITEM, "Show Masked Items", true, mask.show_masked, None::<&str>)?)
    .separator()
    .item(&PredefinedMenuItem::fullscreen(app, None)?)
    .build()
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
  mask: MaskMenu,
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
  menu.insert(&view_submenu(app, view, mask)?, 3)?;
  if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
    help.append(&MenuItem::with_id(app, PERFORMANCE_ITEM, "Performance…", true, None::<&str>)?)?;
  }
  #[cfg(target_os = "macos")]
  {
    replace_about(app, &menu)?;
    replace_quit(app, &menu)?;
  }
  Ok(menu)
}

/// The stock About shows only the release; ours adds the commit it was built from.
#[cfg(target_os = "macos")]
fn replace_about(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
  let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
    return Ok(());
  };
  if let Some(MenuItemKind::Predefined(about)) = app_menu.items()?.into_iter().next() {
    app_menu.remove(&about)?;
    let metadata = AboutMetadata {
      version: Some(app.package_info().version.to_string()),
      short_version: Some(env!("WSLIB_BUILD_ID").into()),
      ..Default::default()
    };
    app_menu.prepend(&PredefinedMenuItem::about(app, None, Some(metadata))?)?;
  }
  Ok(())
}

/// The predefined Quit terminates without an exit the quit guard can hold, so the
/// app submenu's last item becomes `QUIT_MENU_ID` (see `wslib_tauri::quit_guard`).
#[cfg(target_os = "macos")]
fn replace_quit(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
  let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
    return Ok(());
  };
  if let Some(MenuItemKind::Predefined(quit)) = app_menu.items()?.pop() {
    app_menu.remove(&quit)?;
    let label = format!("Quit {}", app.package_info().name);
    app_menu.append(&MenuItem::with_id(app, QUIT_MENU_ID, label, true, Some("CmdOrCtrl+Q"))?)?;
  }
  Ok(())
}

/// Install the initial menu at startup, before the webview has mounted to send a
/// real board list — so the menus are there from the first frame. The view starts
/// on the board with Mask on, matching the stores' defaults.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
  app.set_menu(build_menu(app, &[], None, "board", MaskMenu { mask: true, show_masked: true })?)?;
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
  mask: MaskMenu,
) -> Result<(), String> {
  let _span = crate::perf::metered!();
  let menu = build_menu(&app, &boards, current_id.as_deref(), &view, mask)
    .map_err(|e| format!("Could not build the menu: {e}"))?;
  app.set_menu(menu).map_err(|e| format!("Could not set the menu: {e}"))?;
  Ok(())
}

/// Turn a menu click into a `menu:board` event for the webview. Predefined items
/// (Copy, …), Quit (the quit guard's) and the empty-list placeholder fall through
/// to nothing.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
  let id = event.id().as_ref();
  // The Inbox reveal needs nothing from the webview — the folder is a fixed path —
  // so the shell handles it directly rather than round-tripping an event.
  if id == "inbox.reveal" {
    if let Err(e) = crate::board_store::inbox::open_inbox(app) {
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
    let Some(action) = board_action(id) else { return };
    BoardMenuEvent { action: action.into(), id: None }
  };
  let _ = app.emit("menu:board", evt);
}

const PERFORMANCE_ITEM: &str = "performance";

/// The `menu:board` action an item sends, as `src/platform/boardMenu.ts` reads it.
fn board_action(id: &str) -> Option<&'static str> {
  Some(match id {
    "board.new" => "new",
    "board.manage" => "manage",
    "board.import" => "import",
    "board.export" => "export",
    "board.properties" => "properties",
    "library.mcp" => "libraryMcp",
    MASK_ITEM => "mask",
    SHOW_MASKED_ITEM => "showMasked",
    PERFORMANCE_ITEM => "performance",
    _ => return None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_help_menus_performance_item_opens_the_panel() {
    assert_eq!(board_action(PERFORMANCE_ITEM), Some("performance"));
    assert_eq!(board_action("view.board"), None);
  }

  #[test]
  fn the_view_menus_mask_items_toggle_the_webviews_controls() {
    assert_eq!(board_action(MASK_ITEM), Some("mask"));
    assert_eq!(board_action(SHOW_MASKED_ITEM), Some("showMasked"));
  }
}
