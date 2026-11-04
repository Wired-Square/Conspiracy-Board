//! The meter: how long each command, library MCP tool and webview step took, kept in
//! memory. Its lock is its own, held only to fold one sample in or copy a report out.

use std::cell::Cell;
use std::ops::Add;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const RING: usize = 256;
const SLOWEST: usize = 50;
/// Bounds the table if a caller ever reports names without end.
const MAX_OPS: usize = 512;
const SLOW: Duration = Duration::from_millis(250);

/// What a call handled: rows (or cards) in and out, and bytes sent with `doc:changed`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Size {
  pub rows_in: u32,
  pub rows_out: u32,
  pub bytes: u32,
}

impl Add for Size {
  type Output = Size;
  fn add(self, other: Size) -> Size {
    Size {
      rows_in: self.rows_in.saturating_add(other.rows_in),
      rows_out: self.rows_out.saturating_add(other.rows_out),
      bytes: self.bytes.saturating_add(other.bytes),
    }
  }
}

fn saturate(n: usize) -> u32 {
  u32::try_from(n).unwrap_or(u32::MAX)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpStats {
  pub name: String,
  #[cfg_attr(test, ts(type = "number"))]
  pub count: u64,
  pub p50_ms: f64,
  pub p95_ms: f64,
  pub max_ms: f64,
  pub last_ms: f64,
  /// The last call's size: an op's sizes otherwise show only among the slowest calls.
  pub last_size: Size,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SlowCall {
  pub name: String,
  pub ms: f64,
  /// Unix milliseconds.
  #[cfg_attr(test, ts(type = "number"))]
  pub at: u64,
  #[serde(flatten)]
  pub size: Size,
}

/// Operations by p95, slowest first, and the slowest calls since the last reset.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PerfReport {
  pub ops: Vec<OpStats>,
  pub slowest: Vec<SlowCall>,
}

/// One step the webview timed.
#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UiSample {
  name: String,
  ms: f64,
  #[cfg_attr(test, ts(optional))]
  rows_in: Option<u32>,
  #[cfg_attr(test, ts(optional))]
  rows_out: Option<u32>,
}

struct Op {
  name: Box<str>,
  count: u64,
  ring: [u32; RING],
  next: usize,
  max_us: u32,
  last_us: u32,
  last_size: Size,
}

struct Call {
  op: usize,
  us: u32,
  size: Size,
  at: u64,
}

pub(crate) struct Meter {
  ops: Vec<Op>,
  slowest: Vec<Call>,
}

impl Meter {
  pub(crate) const fn new() -> Self {
    Meter { ops: Vec::new(), slowest: Vec::new() }
  }

  pub(crate) fn record(&mut self, name: &str, took: Duration, size: Size, at: u64) {
    let Some(op) = self.op(name) else { return };
    let us = u32::try_from(took.as_micros()).unwrap_or(u32::MAX);
    let entry = &mut self.ops[op];
    entry.ring[entry.next] = us;
    entry.next = (entry.next + 1) % RING;
    entry.count += 1;
    entry.max_us = entry.max_us.max(us);
    entry.last_us = us;
    entry.last_size = size;

    let call = Call { op, us, size, at };
    if self.slowest.len() < SLOWEST {
      self.slowest.push(call);
    } else if let Some(fastest) = self.slowest.iter_mut().min_by_key(|c| c.us).filter(|c| c.us < us) {
      *fastest = call;
    }
  }

  fn op(&mut self, name: &str) -> Option<usize> {
    if let Some(i) = self.ops.iter().position(|o| &*o.name == name) {
      return Some(i);
    }
    if self.ops.len() == MAX_OPS {
      return None;
    }
    let op =
      Op { name: name.into(), count: 0, ring: [0; RING], next: 0, max_us: 0, last_us: 0, last_size: Size::default() };
    self.ops.push(op);
    Some(self.ops.len() - 1)
  }

  pub(crate) fn report(&self) -> PerfReport {
    let mut ops: Vec<OpStats> = self.ops.iter().map(Op::stats).collect();
    ops.sort_by(|a, b| b.p95_ms.total_cmp(&a.p95_ms).then(b.max_ms.total_cmp(&a.max_ms)));
    let mut slowest: Vec<SlowCall> = self
      .slowest
      .iter()
      .map(|c| SlowCall { name: self.ops[c.op].name.to_string(), ms: ms(c.us), at: c.at, size: c.size })
      .collect();
    slowest.sort_by(|a, b| b.ms.total_cmp(&a.ms));
    PerfReport { ops, slowest }
  }

  pub(crate) fn reset(&mut self) {
    *self = Meter::new();
  }
}

impl Op {
  fn stats(&self) -> OpStats {
    let filled = usize::try_from(self.count).unwrap_or(RING).min(RING);
    let mut recent = self.ring[..filled].to_vec();
    recent.sort_unstable();
    OpStats {
      name: self.name.to_string(),
      count: self.count,
      p50_ms: ms(nearest_rank(&recent, 50)),
      p95_ms: ms(nearest_rank(&recent, 95)),
      max_ms: ms(self.max_us),
      last_ms: ms(self.last_us),
      last_size: self.last_size,
    }
  }
}

fn nearest_rank(sorted: &[u32], percent: usize) -> u32 {
  match sorted.len() {
    0 => 0,
    n => sorted[(n * percent).div_ceil(100).max(1) - 1],
  }
}

fn ms(us: u32) -> f64 {
  f64::from(us) / 1000.0
}

static METER: Mutex<Meter> = Mutex::new(Meter::new());

fn meter() -> MutexGuard<'static, Meter> {
  METER.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn record(name: &str, took: Duration, size: Size) {
  let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
  meter().record(name, took, size, at);
  if took >= SLOW {
    let Size { rows_in, rows_out, bytes } = size;
    log::warn!("[perf] {name} took {} ms ({rows_in} rows in, {rows_out} out, {bytes} bytes)", took.as_millis());
  }
}

pub(crate) fn report() -> PerfReport {
  meter().report()
}

pub(crate) fn reset() {
  meter().reset();
}

thread_local! {
  static EMITTED: Cell<Size> = const { Cell::new(Size { rows_in: 0, rows_out: 0, bytes: 0 }) };
}

/// Counts a `doc:changed` against the span running on this thread.
pub(crate) fn emitted(rows: usize, bytes: usize) {
  EMITTED.with(|e| e.set(e.get() + Size { rows_in: 0, rows_out: saturate(rows), bytes: saturate(bytes) }));
}

/// Times its scope; what is emitted on this thread meanwhile counts towards its size.
pub(crate) struct Span {
  name: &'static str,
  start: Instant,
  size: Size,
  outer: Size,
}

impl Span {
  pub(crate) fn start(name: &'static str) -> Self {
    Span { name, start: Instant::now(), size: Size::default(), outer: EMITTED.replace(Size::default()) }
  }

  pub(crate) fn rows(&mut self, rows_in: usize, rows_out: usize) {
    self.size = self.size + Size { rows_in: saturate(rows_in), rows_out: saturate(rows_out), bytes: 0 };
  }
}

impl Drop for Span {
  fn drop(&mut self) {
    let inner = EMITTED.get();
    EMITTED.set(self.outer + inner);
    record(self.name, self.start.elapsed(), self.size + inner);
  }
}

pub(crate) fn command_name(path: &'static str) -> &'static str {
  let path = path.strip_suffix("::here").unwrap_or(path);
  path.rsplit("::").find(|segment| *segment != "{{closure}}").unwrap_or(path)
}

/// A [`Span`] named for the enclosing function.
macro_rules! metered {
  () => {{
    fn here() {}
    $crate::perf::Span::start($crate::perf::command_name(std::any::type_name_of_val(&here)))
  }};
}
pub(crate) use metered;

#[tauri::command(async)]
pub fn perf_report() -> PerfReport {
  let _span = metered!();
  report()
}

#[tauri::command(async)]
pub fn perf_reset() {
  let _span = metered!();
  reset();
}

#[tauri::command(async)]
pub fn perf_record(samples: Vec<UiSample>) {
  let _span = metered!();
  for s in samples {
    let took = Duration::try_from_secs_f64(s.ms / 1000.0).unwrap_or_default();
    record(&s.name, took, Size { rows_in: s.rows_in.unwrap_or(0), rows_out: s.rows_out.unwrap_or(0), bytes: 0 });
  }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod seed;
