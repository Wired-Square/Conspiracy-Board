//! Whether the library MCP is on, and the listener that follows it: started at launch
//! when the setting is on, and on enable; stopped on disable; restarted on a new token.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use wslib_secret::{Secret, SecretStore};

use super::{random_token, start, Listening, PORT};
use crate::board_store::board_index::{library_mcp_enabled, set_library_mcp_enabled};
use crate::board_store::library_dir;
use crate::library_index::LibraryDb;

const CHANGED: &str = "library-mcp:changed";
const STOP_WAIT: Duration = Duration::from_secs(2);
const TOKEN_SERVICE: &str = "com.wiredsquare.conspiracy";
const TOKEN_ACCOUNT: &str = "library-mcp-token";

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
  store: Arc<dyn SecretStore>,
  /// Serialises the changes and is held across the store, which can wait on a Keychain
  /// prompt; `status` takes only `listener`, so a prompt never holds it up.
  changing: Mutex<()>,
  listener: Mutex<Listener>,
}

#[derive(Default)]
struct Listener {
  token: Option<Secret>,
  running: Option<Listening>,
  error: Option<String>,
}

impl Listener {
  fn stop(&mut self) {
    if self.running.take().is_some_and(|listening| !listening.stop(STOP_WAIT)) {
      log::warn!("[library-mcp] the old server is still closing its connections");
    }
  }

  fn fail(&mut self, error: String) {
    log::warn!("[library-mcp] {error}");
    self.error = Some(error);
  }
}

fn locked<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
  mutex.lock().map_err(|_| "The library MCP is unavailable.".to_string())
}

impl LibraryMcp {
  fn new(library: PathBuf, port: u16, store: Arc<dyn SecretStore>) -> Self {
    Self { library, port, store, changing: Mutex::default(), listener: Mutex::default() }
  }

  fn lock(&self) -> Result<MutexGuard<'_, Listener>, String> {
    locked(&self.listener)
  }

  fn kept_or_new_token(&self) -> Result<Secret, String> {
    if let Some(token) = self.lock()?.token.clone() {
      return Ok(token);
    }
    let kept = self.store.load(TOKEN_SERVICE, TOKEN_ACCOUNT);
    match kept.map_err(|e| format!("The token could not be read from the Keychain: {e}"))? {
      Some(token) => Ok(token),
      None => self.keep_new_token(),
    }
  }

  fn keep_new_token(&self) -> Result<Secret, String> {
    let token = Secret::new(random_token()?);
    let saved = self.store.save(TOKEN_SERVICE, TOKEN_ACCOUNT, &token);
    saved.map_err(|e| format!("The token could not be saved to the Keychain: {e}"))?;
    Ok(token)
  }

  fn report(&self, listener: &Listener, db: &LibraryDb) -> Reply {
    Ok(LibraryMcpStatus {
      enabled: library_mcp_enabled(&*db.lock_db()?)?,
      running: listener.running.is_some(),
      url: format!("http://127.0.0.1:{}/mcp", self.port),
      token: listener.token.as_ref().map(|token| token.expose().to_owned()),
      error: listener.error.clone(),
    })
  }

  fn restart(&self, listener: &mut Listener, token: Secret) {
    listener.stop();
    let token = listener.token.insert(token).expose().to_owned();
    match start(self.library.clone(), self.port, token) {
      Ok(listening) => (listener.running, listener.error) = (Some(listening), None),
      Err(e) => listener.fail(format!("Not started on port {}: {e}", self.port)),
    }
  }

  fn status(&self, db: &LibraryDb) -> Reply {
    self.report(&*self.lock()?, db)
  }

  fn resume(&self, db: &LibraryDb) -> Reply {
    let _changing = locked(&self.changing)?;
    let enabled = library_mcp_enabled(&*db.lock_db()?)?;
    if enabled { self.serve(db) } else { self.status(db) }
  }

  fn enable(&self, db: &LibraryDb) -> Reply {
    let _changing = locked(&self.changing)?;
    set_library_mcp_enabled(&*db.lock_db()?, true)?;
    self.serve(db)
  }

  /// Also Retry's: a running server has the kept token, so an error a failed rotate left is past.
  fn serve(&self, db: &LibraryDb) -> Reply {
    let token = self.kept_or_new_token();
    let mut listener = self.lock()?;
    match token {
      _ if listener.running.is_some() => listener.error = None,
      Ok(token) => self.restart(&mut listener, token),
      Err(e) => listener.fail(e),
    }
    self.report(&listener, db)
  }

  fn disable(&self, db: &LibraryDb) -> Reply {
    let _changing = locked(&self.changing)?;
    let mut listener = self.lock()?;
    set_library_mcp_enabled(&*db.lock_db()?, false)?;
    listener.stop();
    listener.error = None;
    self.report(&listener, db)
  }

  fn rotate_token(&self, db: &LibraryDb) -> Reply {
    let _changing = locked(&self.changing)?;
    let token = self.keep_new_token();
    let mut listener = self.lock()?;
    match token {
      Ok(token) if listener.running.is_some() => self.restart(&mut listener, token),
      Ok(token) => listener.token = Some(token),
      Err(e) => listener.fail(e),
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
  app.manage(LibraryMcp::new(library_dir(app)?, PORT, Arc::new(wslib_secret::Keychain)));
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

/// Off the async workers, as `Listening::stop` needs.
async fn on_blocking_pool(work: impl FnOnce() -> Reply + Send + 'static) -> Reply {
  tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

async fn change(app: AppHandle, act: fn(&LibraryMcp, &LibraryDb) -> Reply) -> Reply {
  let worker = app.clone();
  let status = on_blocking_pool(move || act(&worker.state::<LibraryMcp>(), &worker.state::<LibraryDb>())).await;
  announce(&app, status)
}

#[tauri::command]
pub async fn enable_library_mcp(app: AppHandle) -> Reply {
  change(app, LibraryMcp::enable).await
}

#[tauri::command]
pub async fn disable_library_mcp(app: AppHandle) -> Reply {
  change(app, LibraryMcp::disable).await
}

#[tauri::command]
pub async fn rotate_library_mcp_token(app: AppHandle) -> Reply {
  change(app, LibraryMcp::rotate_token).await
}

#[cfg(test)]
mod tests {
  use std::io::{Read, Write};
  use std::net::{TcpListener, TcpStream};
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::mpsc;
  use std::thread;

  use wslib_secret::{MemoryStore, StoreError};

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

  const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#;

  fn send(port: u16, token: &str, method: &str, rest: &str) -> (TcpStream, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(stream, "{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n{rest}").unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
      stream.read_exact(&mut byte).unwrap();
      head.push(byte[0]);
    }
    let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 200"), "{head}");
    (stream, head)
  }

  /// A client's session with its event stream held open, as an MCP client keeps one.
  fn held_event_stream(port: u16, token: &str) -> TcpStream {
    let initialize = format!(
      "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
       Content-Length: {}\r\n\r\n{INITIALIZE}",
      INITIALIZE.len()
    );
    let (_, head) = send(port, token, "POST", &initialize);
    let session = head.lines().find_map(|l| l.strip_prefix("mcp-session-id: ")).unwrap().trim();
    let events = format!("Accept: text/event-stream\r\nMcp-Session-Id: {session}\r\n\r\n");
    send(port, token, "GET", &events).0
  }

  fn closed(mut stream: TcpStream) -> bool {
    stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
    let mut buf = [0u8; 4096];
    loop {
      match stream.read(&mut buf) {
        Ok(0) => return true,
        Ok(_) => {}
        Err(e) => return !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
      }
    }
  }

  fn as_a_command(mcp: &Arc<LibraryMcp>, db: &Arc<LibraryDb>, change: fn(&LibraryMcp, &LibraryDb) -> Reply) -> LibraryMcpStatus {
    let (mcp, db) = (mcp.clone(), db.clone());
    let command = tauri::async_runtime::spawn(on_blocking_pool(move || change(&mcp, &db)));
    tauri::async_runtime::block_on(command).unwrap().unwrap()
  }

  fn in_memory(dir: &std::path::Path, port: u16) -> LibraryMcp {
    LibraryMcp::new(dir.to_path_buf(), port, Arc::new(MemoryStore::default()))
  }

  fn kept(store: &dyn SecretStore) -> Option<String> {
    let token = store.load(TOKEN_SERVICE, TOKEN_ACCOUNT).unwrap();
    token.map(|token| token.expose().to_owned())
  }

  #[derive(Default)]
  struct Failing {
    failing: AtomicBool,
    kept: MemoryStore,
  }

  impl Failing {
    fn check(&self) -> Result<(), StoreError> {
      match self.failing.load(Ordering::SeqCst) {
        true => Err(StoreError::Denied),
        false => Ok(()),
      }
    }
  }

  impl SecretStore for Failing {
    fn load(&self, service: &str, account: &str) -> Result<Option<Secret>, StoreError> {
      self.check()?;
      self.kept.load(service, account)
    }

    fn save(&self, service: &str, account: &str, secret: &Secret) -> Result<(), StoreError> {
      self.check()?;
      self.kept.save(service, account, secret)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), StoreError> {
      self.check()?;
      self.kept.delete(service, account)
    }
  }

  /// A load that waits, as one does on a Keychain prompt, until the test answers it.
  struct Prompting {
    asked: Mutex<mpsc::Sender<()>>,
    answered: Mutex<mpsc::Receiver<()>>,
    kept: MemoryStore,
  }

  impl SecretStore for Prompting {
    fn load(&self, service: &str, account: &str) -> Result<Option<Secret>, StoreError> {
      self.asked.lock().unwrap().send(()).unwrap();
      self.answered.lock().unwrap().recv().unwrap();
      self.kept.load(service, account)
    }

    fn save(&self, service: &str, account: &str, secret: &Secret) -> Result<(), StoreError> {
      self.kept.save(service, account, secret)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), StoreError> {
      self.kept.delete(service, account)
    }
  }

  fn token(status: &LibraryMcpStatus) -> &str {
    status.token.as_deref().unwrap()
  }

  #[test]
  fn enable_starts_the_listener_and_disable_stops_it() {
    let dir = temp_dir_for("library-mcp-toggle");
    let db = open_at(&dir).unwrap();
    let port = free_port();
    let mcp = in_memory(&dir, port);
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

    let again = mcp.enable(&db).unwrap();
    assert_eq!((again.running, token(&again)), (true, token(&on)));
    assert_ne!(http_status(port, token(&on)), 401);
    mcp.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_kept_token_survives_a_relaunch() {
    let dir = temp_dir_for("library-mcp-relaunch");
    let (db, port) = (open_at(&dir).unwrap(), free_port());
    let store = Arc::new(MemoryStore::default());
    let launched = LibraryMcp::new(dir.clone(), port, store.clone());
    let first = launched.enable(&db).unwrap();
    assert_eq!(kept(&*store).as_deref(), Some(token(&first)));
    launched.disable(&db).unwrap();
    set_library_mcp_enabled(&*db.lock_db().unwrap(), true).unwrap();

    let relaunched = LibraryMcp::new(dir.clone(), port, store);
    let resumed = relaunched.resume(&db).unwrap();
    assert_eq!((resumed.running, token(&resumed)), (true, token(&first)));
    assert_ne!(http_status(port, token(&first)), 401);
    relaunched.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_rotated_token_is_kept_before_the_restart() {
    let dir = temp_dir_for("library-mcp-rotate-kept");
    let (db, port) = (open_at(&dir).unwrap(), free_port());
    let store = Arc::new(MemoryStore::default());
    let mcp = LibraryMcp::new(dir.clone(), port, store.clone());
    let before = mcp.enable(&db).unwrap();
    let after = mcp.rotate_token(&db).unwrap();
    assert_ne!(token(&after), token(&before));
    assert_eq!(kept(&*store).as_deref(), Some(token(&after)));
    mcp.disable(&db).unwrap();
    assert_eq!(kept(&*store).as_deref(), Some(token(&after)));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_failing_store_shows_its_error_and_serves_no_token_it_cannot_keep() {
    let dir = temp_dir_for("library-mcp-store-fails");
    let (db, port) = (open_at(&dir).unwrap(), free_port());
    let store = Arc::new(Failing::default());
    let mcp = LibraryMcp::new(dir.clone(), port, store.clone());
    store.failing.store(true, Ordering::SeqCst);
    let refused = mcp.enable(&db).unwrap();
    assert_eq!((refused.enabled, refused.running, refused.token), (true, false, None));
    assert!(refused.error.unwrap().contains("denied"));

    store.failing.store(false, Ordering::SeqCst);
    let on = mcp.enable(&db).unwrap();
    assert_eq!((on.running, &on.error), (true, &None));
    store.failing.store(true, Ordering::SeqCst);
    let unrotated = mcp.rotate_token(&db).unwrap();
    assert_eq!((unrotated.running, token(&unrotated)), (true, token(&on)));
    assert!(unrotated.error.unwrap().contains("denied"));
    assert_ne!(http_status(port, token(&on)), 401);
    mcp.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn retry_after_a_failed_rotate_clears_the_error_and_keeps_serving() {
    let dir = temp_dir_for("library-mcp-retry-rotate");
    let (db, port) = (open_at(&dir).unwrap(), free_port());
    let store = Arc::new(Failing::default());
    let mcp = LibraryMcp::new(dir.clone(), port, store.clone());
    let on = mcp.enable(&db).unwrap();
    store.failing.store(true, Ordering::SeqCst);
    assert!(mcp.rotate_token(&db).unwrap().error.is_some());

    store.failing.store(false, Ordering::SeqCst);
    let retried = mcp.enable(&db).unwrap();
    assert_eq!((retried.running, token(&retried), &retried.error), (true, token(&on), &None));
    assert_eq!(kept(&store.kept).as_deref(), Some(token(&on)));
    assert_ne!(http_status(port, token(&on)), 401);
    mcp.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_keychain_prompt_at_launch_does_not_hold_up_the_status() {
    let dir = temp_dir_for("library-mcp-prompt");
    let (db, port) = (Arc::new(open_at(&dir).unwrap()), free_port());
    set_library_mcp_enabled(&*db.lock_db().unwrap(), true).unwrap();
    let (asked, prompted) = mpsc::channel();
    let (answer, answered) = mpsc::channel();
    let store = Prompting { asked: Mutex::new(asked), answered: Mutex::new(answered), kept: MemoryStore::default() };
    let mcp = Arc::new(LibraryMcp::new(dir.clone(), port, Arc::new(store)));
    let launch = thread::spawn({
      let (mcp, db) = (mcp.clone(), db.clone());
      move || mcp.resume(&db).unwrap()
    });
    prompted.recv().unwrap();

    let (reply, replied) = mpsc::channel();
    thread::spawn({
      let (mcp, db) = (mcp.clone(), db.clone());
      move || reply.send(mcp.status(&db).unwrap()).unwrap()
    });
    let waiting = replied.recv_timeout(Duration::from_secs(5)).expect("the status waited on the prompt");
    assert_eq!((waiting.enabled, waiting.running, waiting.token), (true, false, None));

    answer.send(()).unwrap();
    assert!(launch.join().unwrap().running);
    mcp.disable(&db).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_rotated_token_replaces_the_old_one_on_the_listener() {
    let dir = temp_dir_for("library-mcp-rotate");
    let db = open_at(&dir).unwrap();
    let port = free_port();
    let mcp = in_memory(&dir, port);
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
    let mcp = in_memory(&dir, taken.local_addr().unwrap().port());
    let status = mcp.enable(&db).unwrap();
    assert_eq!((status.enabled, status.running), (true, false));
    assert!(status.error.is_some());

    let relaunched = in_memory(&dir, taken.local_addr().unwrap().port());
    let resumed = relaunched.resume(&db).unwrap();
    assert_eq!((resumed.enabled, resumed.running, resumed.error.is_some()), (true, false, true));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_rotate_with_a_session_open_rebinds_and_drops_the_old_connection() {
    let dir = temp_dir_for("library-mcp-rotate-session");
    let (db, port) = (Arc::new(open_at(&dir).unwrap()), free_port());
    let mcp = Arc::new(in_memory(&dir, port));
    let before = as_a_command(&mcp, &db, LibraryMcp::enable);
    let session = held_event_stream(port, token(&before));
    let after = as_a_command(&mcp, &db, LibraryMcp::rotate_token);
    assert_eq!((after.running, &after.error), (true, &None));
    assert!(closed(session));
    assert_eq!(http_status(port, token(&before)), 401);
    assert_ne!(http_status(port, token(&after)), 401);
    as_a_command(&mcp, &db, LibraryMcp::disable);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_disable_with_a_session_open_frees_the_port_and_drops_the_connection() {
    let dir = temp_dir_for("library-mcp-disable-session");
    let (db, port) = (Arc::new(open_at(&dir).unwrap()), free_port());
    let mcp = Arc::new(in_memory(&dir, port));
    let on = as_a_command(&mcp, &db, LibraryMcp::enable);
    let session = held_event_stream(port, token(&on));
    assert!(!as_a_command(&mcp, &db, LibraryMcp::disable).running);
    assert!(closed(session));
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
