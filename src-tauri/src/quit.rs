//! Board writes in flight, which `wslib_tauri::quit_guard` holds a quit for. Each
//! command that writes a board holds one for as long as it runs.

use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct InFlight(AtomicUsize);

pub struct Held<'a>(&'a InFlight);

impl InFlight {
  pub fn hold(&self) -> Held<'_> {
    self.0.fetch_add(1, Ordering::SeqCst);
    Held(self)
  }

  fn busy(&self) -> bool {
    self.0.load(Ordering::SeqCst) > 0
  }
}

impl Drop for Held<'_> {
  fn drop(&mut self) {
    self.0 .0.fetch_sub(1, Ordering::SeqCst);
  }
}

pub fn hold(app: &AppHandle) -> Held<'_> {
  app.state::<InFlight>().inner().hold()
}

pub fn is_busy(app: &AppHandle) -> bool {
  app.state::<InFlight>().busy()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn busy_while_any_write_is_held() {
    let writes = InFlight::default();
    assert!(!writes.busy());
    let first = writes.hold();
    let second = writes.hold();
    drop(first);
    assert!(writes.busy());
    drop(second);
    assert!(!writes.busy());
  }
}
