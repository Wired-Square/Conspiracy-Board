import { invoke } from '@tauri-apps/api/core';
import type { PerfReport } from '../bindings/PerfReport';
import type { UiSample } from '../bindings/UiSample';

export type { PerfReport };

const FLUSH_MS = 2000;
const FRAME_GAP_MS = 50;
const MAX_PENDING = 2000;

let pending: UiSample[] = [];
let shownAt = 0;

/** Queues a webview timing for the shell's meter (src-tauri/src/perf.rs), as `ui:<name>`. */
export function record(name: string, ms: number, rowsIn?: number, rowsOut?: number): void {
  if (pending.length < MAX_PENDING) pending.push({ name: `ui:${name}`, ms, rowsIn, rowsOut });
}

/** Runs `step` and records how long it took; `size` gives the rows it took in and gave out. */
export function measure<T>(name: string, step: () => T, size?: (result: T) => [number, number]): T {
  const start = performance.now();
  const result = step();
  const [rowsIn, rowsOut] = size?.(result) ?? [];
  record(name, performance.now() - start, rowsIn, rowsOut);
  return result;
}

/** Records the time until the next frame has painted. Hidden windows stall frames, so a wait across one is dropped. */
export function untilPainted(name: string, rows?: number): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const start = performance.now();
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (!document.hidden && shownAt <= start) record(name, performance.now() - start, undefined, rows);
    }),
  );
}

export async function flushPerf(): Promise<void> {
  if (!pending.length) return;
  const samples = pending;
  pending = [];
  await invoke('perf_record', { samples }).catch(() => {});
}

export const perf = {
  report: async () => {
    await flushPerf();
    return invoke<PerfReport>('perf_report');
  },
  reset: async () => {
    pending = [];
    await invoke('perf_reset');
  },
};

/** Watches for frame gaps (WebKit has no long-task observer) and sends the queue in batches. */
export function startPerfMeter(): () => void {
  let last = performance.now();
  let frame = requestAnimationFrame(function tick(now) {
    if (now - last > FRAME_GAP_MS) record('frame gap', now - last);
    last = now;
    frame = requestAnimationFrame(tick);
  });
  const onVisibility = () => {
    last = shownAt = performance.now();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const timer = setInterval(() => void flushPerf(), FLUSH_MS);
  return () => {
    cancelAnimationFrame(frame);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
