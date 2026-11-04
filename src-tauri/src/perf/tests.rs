use super::*;

fn us(n: u64) -> Duration {
  Duration::from_micros(n)
}

fn stats<'a>(report: &'a PerfReport, name: &str) -> &'a OpStats {
  report.ops.iter().find(|o| o.name == name).unwrap()
}

#[test]
fn an_operation_keeps_its_count_max_and_last_and_takes_percentiles_from_its_ring() {
  let mut meter = Meter::new();
  for n in 1..=100 {
    meter.record("op", us(n * 1000), Size::default(), 0);
  }
  let op = stats(&meter.report(), "op").clone();
  assert_eq!((op.count, op.p50_ms, op.p95_ms, op.max_ms, op.last_ms), (100, 50.0, 95.0, 100.0, 100.0));

  for _ in 0..RING {
    meter.record("op", us(2000), Size::default(), 0);
  }
  let op = stats(&meter.report(), "op").clone();
  assert_eq!((op.count, op.p50_ms, op.p95_ms, op.max_ms), (100 + RING as u64, 2.0, 2.0, 100.0));
}

#[test]
fn operations_list_slowest_first_by_p95() {
  let mut meter = Meter::new();
  meter.record("quick", us(10), Size::default(), 0);
  meter.record("slow", us(900), Size::default(), 0);
  meter.record("middling", us(400), Size::default(), 0);
  let names: Vec<_> = meter.report().ops.into_iter().map(|o| o.name).collect();
  assert_eq!(names, ["slow", "middling", "quick"]);
}

#[test]
fn the_slowest_calls_are_kept_with_their_sizes_slowest_first() {
  let mut meter = Meter::new();
  for n in 1..=(SLOWEST as u64 + 20) {
    meter.record("op", us(n), Size { rows_in: n as u32, rows_out: 0, bytes: 7 }, n);
  }
  let slowest = meter.report().slowest;
  assert_eq!(slowest.len(), SLOWEST);
  let size = Size { rows_in: 70, rows_out: 0, bytes: 7 };
  assert_eq!(slowest[0], SlowCall { name: "op".into(), ms: 0.07, at: 70, size });
  assert_eq!(slowest.last().unwrap().at, 21);
}

#[test]
fn the_table_stops_growing_at_its_bound_and_reset_empties_it() {
  let mut meter = Meter::new();
  for n in 0..MAX_OPS + 5 {
    meter.record(&format!("op{n}"), us(1), Size::default(), 0);
  }
  meter.record("op0", us(1), Size::default(), 0);
  let report = meter.report();
  assert_eq!(report.ops.len(), MAX_OPS);
  assert_eq!(stats(&report, "op0").count, 2);
  meter.reset();
  assert_eq!(meter.report(), PerfReport::default());
}

fn sync_command() -> &'static str {
  metered!().name
}

async fn async_command() -> &'static str {
  metered!().name
}

#[test]
fn a_metered_span_is_named_for_its_function() {
  assert_eq!(sync_command(), "sync_command");
  assert_eq!(tauri::async_runtime::block_on(async_command()), "async_command");
}

#[test]
fn a_span_counts_what_its_thread_emitted_and_its_enclosing_span_does_too() {
  {
    let mut outer = Span::start("perf-test-outer");
    outer.rows(3, 0);
    emitted(1, 100);
    {
      let _inner = Span::start("perf-test-inner");
      emitted(2, 50);
    }
  }
  emitted(9, 9);
  drop(Span::start("perf-test-after"));
  let calls = report().slowest;
  let size = |name: &str| calls.iter().find(|c| c.name == name).map(|c| c.size);
  assert_eq!(size("perf-test-inner"), Some(Size { rows_in: 0, rows_out: 2, bytes: 50 }));
  assert_eq!(size("perf-test-outer"), Some(Size { rows_in: 3, rows_out: 3, bytes: 150 }));
  assert_eq!(size("perf-test-after").map(|s| s.bytes), Some(0));
}

#[test]
fn every_tauri_command_is_metered() {
  let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
  let mut unmetered = Vec::new();
  let mut dirs = vec![src];
  while let Some(dir) = dirs.pop() {
    for path in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
      if path.is_dir() {
        dirs.push(path);
        continue;
      }
      if path.extension().is_none_or(|x| x != "rs") {
        continue;
      }
      let text = std::fs::read_to_string(&path).unwrap();
      let lines: Vec<&str> = text.lines().collect();
      for (i, _) in lines.iter().enumerate().filter(|(_, l)| l.trim_start().starts_with("#[tauri::command")) {
        let open = (i..lines.len()).find(|&j| lines[j].trim_end().ends_with('{')).unwrap();
        if !lines[open + 1].contains("metered!()") {
          unmetered.push(format!("{}:{}", path.display(), open + 1));
        }
      }
    }
  }
  assert!(unmetered.is_empty(), "commands without `metered!()` first: {unmetered:?}");
}
