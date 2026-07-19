//! Importing a message dragged out of Apple Mail, body and all.
//!
//! A web page dragged a message from Mail gets two strings: the subject and a
//! `message:` URL. The body is not on offer, which is why the browser build can
//! only make a reference card (see src/lib/email/mailDrag.ts).
//!
//! The native shell sees more. Mail also puts a **file promise** on the dragging
//! pasteboard, promising `com.apple.mail.email` — the whole .eml, the same file
//! you get dragging a message to the Finder. Taking delivery of it is what turns
//! a Mail drop into a real email card.
//!
//! The catch is that Mail offers the *legacy* promise flavour ("Apple files
//! promise pasteboard type"). `NSFilePromiseReceiver`, the modern reader, cannot
//! take it: for a legacy promise it falls back to the drag session, but
//! `receivePromisedFilesAtDestination:` runs asynchronously, and by the time it
//! does the drag session is gone. It fails with "The operation was cancelled"
//! and Mail is never even asked. So we call the deprecated
//! `namesOfPromisedFilesDroppedAtDestination:` ourselves, synchronously, while
//! the session is still alive. Deprecated since 10.13 and still the only thing
//! that works; if it is ever removed, the app degrades to the reference card the
//! browser build already makes.
//!
//! Delivery is asynchronous even then — Mail writes the file after we have
//! returned — so a watcher thread waits for it and emits `mail-drop`. The web
//! side parses it and completes the card the drop already created, matching on
//! Message-ID. That the .eml's Message-ID equals the one in the pasteboard's
//! `message:` URL is what makes the two halves meet.
//!
//! We interpose by swizzling `performDragOperation:` on the class of record
//! rather than swapping the instance's class (object_setClass): wry keeps KVO
//! observers on the webview, so the live class is already an `NSKVONotifying_`
//! subclass, and slotting another class underneath it trips an assertion in
//! Foundation's dynamic-property machinery. Replacing the method on the class of
//! record leaves KVO's subclass intact and it simply inherits the override.
//! WryWebView is itself the registered drag destination, not one of WKWebView's
//! private inner views.
//!
//! The override always calls through, so the ordinary HTML5 drop still fires and
//! still makes the card — this only adds the body.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use objc2::ffi::{class_replaceMethod, method_getTypeEncoding};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Method, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::{NSFilePromiseReceiver, NSPasteboard, NSPasteboardTypeURL};
use objc2_foundation::{NSString, NSURL};
use serde::Serialize;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The implementation we displaced, so the override can call through to it.
static ORIGINAL: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// Set once at startup; the watcher thread emits through it.
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Names each drop's directory apart from the last one's.
static DROP_SEQ: AtomicUsize = AtomicUsize::new(0);

/// What Mail promises for a message. Gating on it keeps us from fetching and
/// failing to parse a promise from some other app.
const MAIL_EMAIL_TYPE: &str = "com.apple.mail.email";
/// Says what a promise will deliver, without delivering it.
const PROMISED_CONTENT_TYPE: &str = "com.apple.pasteboard.promised-file-content-type";

/// Long enough for Mail to write a message with attachments, short enough that a
/// card does not sit saying "fetching" forever if Mail never answers.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailDropped {
  /// Mail names the file after the subject; the parser sniffs content anyway,
  /// so this is only used for error messages.
  name: String,
  /// Base64 rather than a byte array: a Tauri event is JSON, and a JSON array of
  /// numbers costs ~4x the bytes where base64 costs 4/3. The web side parses this
  /// to build the card; the .eml itself is already kept as `eml_file`.
  b64: String,
  /// Name of the original .eml now kept in the media library, so the card can
  /// link back to the whole message. Empty when keeping it failed — the card is
  /// still made from `b64`, just without the retained original.
  eml_file: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailDropFailed {
  /// The `message:` URL, which is how the web side finds the card to correct.
  url: String,
  reason: String,
}

/// Read a pasteboard string value, if the type is even offered.
fn string_for_type(pasteboard: &NSPasteboard, ty: &NSString) -> Option<String> {
  pasteboard.stringForType(ty).map(|v| v.to_string())
}

/// A directory of this drop's own, so whatever turns up in it is unambiguously
/// this message and two quick drags cannot be confused for each other.
fn drop_dir() -> PathBuf {
  let seq = DROP_SEQ.fetch_add(1, Ordering::Relaxed);
  std::env::temp_dir().join(format!("conspiracy-mail-{}-{seq}", std::process::id()))
}

fn first_file(dir: &Path) -> Option<(PathBuf, u64)> {
  std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
    let meta = e.metadata().ok()?;
    meta.is_file().then(|| (e.path(), meta.len()))
  })
}

/// Wait for Mail to finish writing. A file appearing is not a file finished, so
/// hold out for its size to stop changing rather than racing the writer and
/// parsing half a message.
fn await_delivery(dir: &Path) -> Option<PathBuf> {
  let deadline = Instant::now() + DELIVERY_TIMEOUT;
  let mut settling: Option<(PathBuf, u64)> = None;

  while Instant::now() < deadline {
    std::thread::sleep(POLL);
    let Some((path, len)) = first_file(dir) else {
      continue;
    };
    if len == 0 {
      continue;
    }
    if settling.as_ref().is_some_and(|(p, l)| *p == path && *l == len) {
      return Some(path);
    }
    settling = Some((path, len));
  }
  None
}

fn emit(event: &str, payload: impl Serialize + Clone) {
  if let Some(app) = APP.get() {
    let _ = app.emit(event, payload);
  }
}

/// Keep the delivered .eml in the media library, named by its content hash,
/// returning the name. Empty on failure — the caller makes the card either way.
fn keep_eml(bytes: &[u8]) -> String {
  let Some(app) = APP.get() else {
    return String::new();
  };
  match crate::board_store::store_media_bytes(app, bytes, "eml") {
    Ok(name) => name,
    Err(e) => {
      log::warn!("Could not keep the delivered message: {e}");
      String::new()
    }
  }
}

/// Wait for the promised file, hand it to the web side, and take the temp
/// directory back out with us either way.
fn watch(dir: PathBuf, url: String) {
  std::thread::spawn(move || {
    let outcome = await_delivery(&dir)
      .ok_or_else(|| "Mail did not deliver the message.".to_string())
      .and_then(|path| {
        let name = path
          .file_name()
          .map_or_else(|| "message.eml".to_string(), |n| n.to_string_lossy().into());
        let bytes =
          std::fs::read(&path).map_err(|e| format!("Could not read the delivered message: {e}"))?;
        log::info!("Mail delivered “{name}” ({} bytes)", bytes.len());
        // Keep the original .eml in the library, named by content hash. We
        // already have the bytes here, so there is no reading it into the webview
        // to hand them back for a second write. Failure is not fatal — the card
        // is still made from these bytes, only without a kept original.
        let eml_file = keep_eml(&bytes);
        Ok(MailDropped { name, b64: STANDARD.encode(bytes), eml_file })
      });

    let _ = std::fs::remove_dir_all(&dir);

    match outcome {
      Ok(dropped) => emit("mail-drop", dropped),
      Err(reason) => {
        // This path leans on a deprecated call and an undocumented promise, so
        // say what happened rather than leaving a silent dead end.
        log::warn!("Mail drop failed: {reason}");
        emit("mail-drop-failed", MailDropFailed { url, reason });
      }
    }
  });
}

/// Ask for the promised message, if this drag is one. Everything here must
/// happen before `performDragOperation:` returns and the drag session dies.
unsafe fn request_promised_message(sender: *mut AnyObject) {
  let pasteboard: Option<Retained<NSPasteboard>> = msg_send![sender, draggingPasteboard];
  let Some(pasteboard) = pasteboard else {
    return;
  };

  if pasteboard
    .availableTypeFromArray(&NSFilePromiseReceiver::readableDraggedTypes())
    .is_none()
  {
    return; // A real file, or a plain drag — the HTML5 path already handles it.
  }
  if string_for_type(&pasteboard, &NSString::from_str(PROMISED_CONTENT_TYPE)).as_deref()
    != Some(MAIL_EMAIL_TYPE)
  {
    return; // Some other app promising some other file.
  }

  // Only needed to report failure, and only Mail's drag carries it.
  let url = string_for_type(&pasteboard, NSPasteboardTypeURL).unwrap_or_default();

  let dir = drop_dir();
  if let Err(e) = std::fs::create_dir_all(&dir) {
    emit(
      "mail-drop-failed",
      MailDropFailed { url, reason: format!("Could not make a place to receive it: {e}") },
    );
    return;
  }

  let dest = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
  // Deprecated, and the only call Mail answers — see the module comment. Its
  // return value is not the filename (it hands back the destination directory's
  // own name), so the watcher discovers the file rather than trusting it; we
  // check only that Mail accepted the request at all.
  let names: Option<Retained<AnyObject>> =
    msg_send![sender, namesOfPromisedFilesDroppedAtDestination: &*dest];

  match names {
    Some(_) => watch(dir, url),
    None => {
      let _ = std::fs::remove_dir_all(&dir);
      emit(
        "mail-drop-failed",
        MailDropFailed { url, reason: "Mail refused to hand over the message.".into() },
      );
    }
  }
}

/// Interposed `performDragOperation:`: take the promise, then let the drop
/// proceed exactly as it would have.
unsafe extern "C-unwind" fn perform_drag_operation(
  this: &AnyObject,
  sel: Sel,
  sender: *mut AnyObject,
) -> Bool {
  request_promised_message(sender);

  let original = ORIGINAL.load(Ordering::Acquire);
  if original.is_null() {
    return Bool::NO; // Unreachable: install() stores this before arming.
  }
  let original_fn: unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool =
    std::mem::transmute(original);
  original_fn(this, sel, sender)
}

/// Arm the interposer. Called with Tauri's WKWebView handle.
pub unsafe fn install(app: AppHandle, webview: *mut c_void) {
  let _ = APP.set(app);
  let obj: &AnyObject = &*webview.cast();

  // `-class` is the class of record: KVO overrides it to hide its own subclass,
  // which is exactly the class we want to install onto.
  let cls: &AnyClass = msg_send![obj, class];
  let sel = sel!(performDragOperation:);
  let Some(method) = cls.instance_method(sel) else {
    log::warn!("no performDragOperation: on {}; Mail drops will not carry bodies", cls.name().to_string_lossy());
    return;
  };

  let types = method_getTypeEncoding(method as *const Method);
  let previous = class_replaceMethod(
    cls as *const AnyClass as *mut AnyClass,
    sel,
    std::mem::transmute::<_, Imp>(
      perform_drag_operation as unsafe extern "C-unwind" fn(_, _, _) -> _,
    ),
    types,
  );

  // class_replaceMethod returns null when the class did not define the method
  // itself — it only inherited it. The implementation to call through to is then
  // the inherited one we just looked up, not the (absent) previous one.
  ORIGINAL.store(
    previous.map_or_else(
      || method.implementation() as *mut c_void,
      |imp| imp as *mut c_void,
    ),
    Ordering::Release,
  );
}
