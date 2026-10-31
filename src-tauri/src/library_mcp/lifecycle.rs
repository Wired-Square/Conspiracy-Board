//! Whether the library MCP is on, and the listener that follows it: started at launch
//! when the setting is on, and on enable; stopped on disable; restarted on a new token.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, State};
use wslib_mcp::CancellationToken;

use super::{random_token, start, PORT};
use crate::board_store::board_index::{library_mcp_enabled, set_library_mcp_enabled};
use crate::board_store::library_dir;
use crate::library_index::LibraryDb;

const CHANGED: &str = "library-mcp:changed";

#[derive(Debug, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LibraryMcpStatus {
  enabled: bool,
  running: bool,
  url: String,
  token: Option<String>,
  /// Why the listener is not running although enabled, e.g. the port is taken.
  error: Option<String>,
}

type Reply = Result<LibraryMcpStatus, String>;

pub(crate) struct LibraryMcp {
  library: PathBuf,
  port: u16,
  listener: Mutex<Listener>,
}

#[derive(Default)]
struct Listener {
  // For this launch only until wslib-secret can keep it in the Keychain (D4).
  token: Option<String>,
  running: Option<CancellationToken>,
  error: Option<String>,
}

impl Listener {
  fn stop(&mut self) {
    if let Some(cancel) = self.running.take() {
      cancel.cancel();
    }
  }
}

impl LibraryMcp {
  fn new(library: PathBuf, port: u16) -> Self {
    Self { library, port, listener: Mutex::default() }
  }

  fn lock(&self) -> Result<MutexGuard<'_, Listener>, String> {
    self.listener.lock().map_err(|_| "The library MCP is unavailable.".to_string())
  }

  fn report(&self, listener: &Listener, db: &LibraryDb) -> Reply {
    Ok(LibraryMcpStatus {
      enabled: library_mcp_enabled(&*db.lock_db()?)?,
      running: listener.running.is_some(),
      url: format!("http://127.0.0.1:{}/mcp", self.port),
      token: listener.token.clone(),
      error: listener.error.clone(),
    })
  }

  fn restart(&self, listener: &mut Listener) -> Result<(), String> {
    listener.stop();
    let token = match &listener.token {
      Some(token) => token.clone(),
      None => listener.token.insert(random_token()?).clone(),
    };
    match start(self.library.clone(), self.port, token) {
      Ok(cancel) => (listener.running, listener.error) = (Some(cancel), None),
      Err(e) => {
        log::warn!("[library-mcp] not started on {}: {e}", self.port);
        listener.error = Some(e);
      }
    }
    Ok(())
  }

  fn status(&self, db: &LibraryDb) -> Reply {
    self.report(&*self.lock()?, db)
  }

  fn resume(&self, db: &LibraryDb) -> Reply {
    let mut listener = self.lock()?;
    if library_mcp_enabled(&*db.lock_db()?)? {
      self.restart(&mut listener)?;
    }
    self.report(&listener, db)
  }

  fn enable(&self, db: &LibraryDb) -> Reply {
    let mut listener = self.lock()?;
    set_library_mcp_enabled(&*db.lock_db()?, true)?;
    if listener.running.is_none() {
      self.restart(&mut listener)?;
    }
    self.report(&listener, db)
  }

  fn disable(&self, db: &LibraryDb) -> Reply {
    let mut listener = self.lock()?;
    set_library_mcp_enabled(&*db.lock_db()?, false)?;
    listener.stop();
    listener.error = None;
    self.report(&listener, db)
  }

  fn rotate_token(&self, db: &LibraryDb) -> Reply {
    let mut listener = self.lock()?;
    listener.token = Some(random_token()?);
    if listener.running.is_some() {
      self.restart(&mut listener)?;
    }
    self.report(&listener, db)
  }
}

fn announce(app: &AppHandle, status: Reply) -> Reply {
  if let Ok(status) = &status {
    let _ = app.emit(CHANGED, status);
  }
  status
}

/// Off the setup thread: a taken port holds `start` for its bind retry.
pub(crate) fn manage_and_resume(app: &AppHandle) -> Result<(), String> {
  app.manage(LibraryMcp::new(library_dir(app)?, PORT));
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    if let Err(e) = announce(&app, app.state::<LibraryMcp>().resume(&app.state::<LibraryDb>())) {
      log::warn!("[library-mcp] not resumed: {e}");
    }
  });
  Ok(())
}

#[tauri::command(async)]
pub fn library_mcp_status(mcp: State<LibraryMcp>, db: State<LibraryDb>) -> Reply {
  mcp.status(&db)
}

#[tauri::command(async)]
pub fn enable_library_mcp(app: AppHandle, mcp: State<LibraryMcp>, db: State<LibraryDb>) -> Reply {
  announce(&app, mcp.enable(&db))
}

#[tauri::command(async)]
pub fn disable_library_mcp(app: AppHandle, mcp: State<LibraryMcp>, db: State<LibraryDb>) -> Reply {
  announce(&app, mcp.disable(&db))
}

#[tauri::command(async)]
pub fn rotate_library_mcp_token(app: AppHandle, mcp: State<LibraryMcp>, db: State<LibraryDb>) -> Reply {
  announce(&app, mcp.rotate_token(&db))
}

#[cfg(test)]
mod tests {
  use std::io::{Read, Write};
  use std::net::{TcpListener, TcpStream};

  use super::*;
  use crate::board_store::temp_dir_for;
  use crate::library_index::open_at;

  fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
  }

  fn http_status(port: u16, token: &str) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
      stream,
      "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).unwrap();
    std::str::from_utf8(&head[9..12]).unwrap().parse().unwrap()
  }

  fn token(status: &LibraryMcpStatus) -> &str {
    status.token.as_deref().unwrap()
  }

  #[test]
  fn enable_starts_the_listener_and_disable_stops_it() {
    let dir = temp_dir_for("library-mcp-toggle");
    let db = open_at(&dir).unwrap();
    let port = free_port();
    let mcp = LibraryMcp::new(dir.clone(), port);
    let off = mcp.status(&db).unwrap();
    assert_eq!((off.enabled, off.running, off.token, off.error), (false, false, None, None));
    assert_eq!(off.url, format!("http://127.0.0.1:{port}/mcp"));

    let on = mcp.enable(&db).unwrap();
    assert_eq!((on.enabled, on.running, &on.error), (true, true, &None));
    assert_eq!(mcp.status(&db).unwrap(), on);
    assert_ne!(http_status(port, token(&on)), 401);

    let off = mcp.disable(&db).unwrap();
    assert_eq!((off.enabled, off.running, off.token.as_deref()), (false, false, Some(token(&on))));
    assert!(!library_mcp_enabled(&*db.lock_db().unwrap()).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_rotated_token_replaces_the_old_one_on_the_listener() {
    let dir = temp_dir_for("library-mcp-rotate");
    let db = open_at(&dir).unwrap();
    let port = free_port();
    let mcp = LibraryMcp::new(dir.clone(), port);
    let before = mcp.enable(&db).unwrap();
    let after = mcp.rotate_token(&db).unwrap();
    assert!(after.running);
    assert_ne!(token(&after), token(&before));
    assert_eq!(http_status(port, token(&before)), 401);
    assert_ne!(http_status(port, token(&after)), 401);
    mcp.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_taken_port_leaves_it_enabled_with_the_error_showing() {
    let dir = temp_dir_for("library-mcp-taken");
    let db = open_at(&dir).unwrap();
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let mcp = LibraryMcp::new(dir.clone(), taken.local_addr().unwrap().port());
    let status = mcp.enable(&db).unwrap();
    assert_eq!((status.enabled, status.running), (true, false));
    assert!(status.error.is_some());

    let relaunched = LibraryMcp::new(dir.clone(), taken.local_addr().unwrap().port());
    let resumed = relaunched.resume(&db).unwrap();
    assert_eq!((resumed.enabled, resumed.running, resumed.error.is_some()), (true, false, true));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
