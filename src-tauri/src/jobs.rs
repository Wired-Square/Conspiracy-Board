//! A small pool of worker threads draining a queue of media names. Each name is queued
//! once however often it is asked for; `force` asks for it again even if it is
//! running. `report` hears the count still queued or running after every change.

use std::collections::{HashSet, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

#[derive(Default)]
struct Queue {
  waiting: VecDeque<String>,
  queued: HashSet<String>,
  forced: HashSet<String>,
  running: Vec<String>,
}

impl Queue {
  fn push(&mut self, name: String, force: bool) {
    if force {
      self.forced.insert(name.clone());
    } else if self.running.contains(&name) {
      return;
    }
    if self.queued.insert(name.clone()) {
      self.waiting.push_back(name);
    }
  }

  fn take(&mut self) -> Option<(String, bool)> {
    let name = self.waiting.pop_front()?;
    self.queued.remove(&name);
    self.running.push(name.clone());
    let force = self.forced.remove(&name);
    Some((name, force))
  }

  fn finish(&mut self, name: &str) {
    if let Some(i) = self.running.iter().position(|n| n == name) {
      self.running.swap_remove(i);
    }
  }

  fn pending(&self) -> usize {
    self.waiting.len() + self.running.len()
  }
}

type Report = Box<dyn Fn(usize) + Send + Sync>;

pub struct Jobs {
  queue: Mutex<Queue>,
  wake: Condvar,
  report: Report,
}

impl Jobs {
  pub fn start(
    workers: usize,
    run: impl Fn(&str, bool) + Send + Sync + 'static,
    report: impl Fn(usize) + Send + Sync + 'static,
  ) -> Arc<Jobs> {
    let jobs = Arc::new(Jobs { queue: Mutex::default(), wake: Condvar::new(), report: Box::new(report) });
    let run = Arc::new(run);
    for _ in 0..workers {
      let (jobs, run) = (jobs.clone(), run.clone());
      std::thread::spawn(move || jobs.work(&*run));
    }
    jobs
  }

  pub fn enqueue(&self, names: impl IntoIterator<Item = String>, force: bool) {
    let mut queue = self.lock();
    for name in names {
      queue.push(name, force);
    }
    (self.report)(queue.pending());
    self.wake.notify_all();
  }

  pub fn pending(&self) -> usize {
    self.lock().pending()
  }

  fn lock(&self) -> MutexGuard<'_, Queue> {
    self.queue.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn work(&self, run: &dyn Fn(&str, bool)) {
    loop {
      let (name, force) = {
        let mut queue = self.lock();
        loop {
          if let Some(job) = queue.take() {
            break job;
          }
          queue = self.wake.wait(queue).unwrap_or_else(|e| e.into_inner());
        }
      };
      // An extractor that panics on a malformed file must not take the worker with it.
      let _ = catch_unwind(AssertUnwindSafe(|| run(&name, force)));
      let mut queue = self.lock();
      queue.finish(&name);
      (self.report)(queue.pending());
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;
  use std::time::Duration;

  fn names(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn a_name_is_queued_once_unless_forced() {
    let mut q = Queue::default();
    for n in names(&["a", "b", "a"]) {
      q.push(n, false);
    }
    assert_eq!(q.take(), Some(("a".into(), false)));
    q.push("a".into(), false); // running: not again
    q.push("b".into(), true); // waiting: now forced
    assert_eq!(q.pending(), 2);
    q.push("a".into(), true); // running and forced: once more after
    assert_eq!(q.take(), Some(("b".into(), true)));
    assert_eq!(q.take(), Some(("a".into(), true)));
    assert_eq!(q.pending(), 3);
    q.finish("a");
    q.finish("a");
    q.finish("b");
    assert_eq!((q.pending(), q.take()), (0, None));
  }

  #[test]
  fn the_pool_runs_every_job_and_reports_down_to_zero() {
    let (ran_tx, ran) = mpsc::channel();
    let (report_tx, reports) = mpsc::channel();
    let ran_tx = Mutex::new(ran_tx);
    let report_tx = Mutex::new(report_tx);
    let jobs = Jobs::start(
      3,
      move |name, force| {
        if name == "boom" {
          panic!("a bad file");
        }
        ran_tx.lock().unwrap().send((name.to_string(), force)).unwrap();
      },
      move |pending| report_tx.lock().unwrap().send(pending).unwrap(),
    );
    jobs.enqueue(names(&["a", "boom", "b", "c"]), false);
    jobs.enqueue(names(&["d"]), true);

    let mut done: Vec<_> = (0..4).map(|_| ran.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
    done.sort();
    assert_eq!(
      done,
      vec![("a".into(), false), ("b".into(), false), ("c".into(), false), ("d".into(), true)]
    );
    // An earlier zero may be stale (all four done before `d` was queued); the last is not.
    while reports.recv_timeout(Duration::from_secs(5)).unwrap() != 0 || jobs.pending() != 0 {}
  }
}
