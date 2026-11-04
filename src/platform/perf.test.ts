// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { flushPerf, measure, perf, record, startPerfMeter, untilPainted } from './perf';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
const invoked = vi.mocked(invoke);

const sent = () =>
  invoked.mock.calls.filter(([cmd]) => cmd === 'perf_record').flatMap(([, args]) => (args as { samples: unknown[] }).samples);
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  });
  await flushPerf();
  invoked.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

test('a measured step is sent as ui:<name> with its rows, in one batch', async () => {
  const doubled = measure('double', () => {
    vi.advanceTimersByTime(30);
    return [1, 2, 3].map((n) => n * 2);
  }, (out) => [3, out.length]);
  record('other', 5);
  expect(doubled).toEqual([2, 4, 6]);
  await flushPerf();
  expect(invoked).toHaveBeenCalledTimes(1);
  expect(sent()).toEqual([
    { name: 'ui:double', ms: 30, rowsIn: 3, rowsOut: 3 },
    { name: 'ui:other', ms: 5, rowsIn: undefined, rowsOut: undefined },
  ]);
  await flushPerf();
  expect(invoked).toHaveBeenCalledTimes(1);
});

test('a paint is timed to the frame after it, and dropped when the window hides meanwhile', async () => {
  const stop = startPerfMeter();
  untilPainted('shown', 4);
  vi.advanceTimersByTime(20);
  untilPainted('hidden');
  setHidden(true);
  vi.advanceTimersByTime(40);
  setHidden(false);
  await flushPerf();
  const painted = sent() as { name: string; rowsOut?: number }[];
  expect(painted.filter((s) => s.name === 'ui:shown')).toMatchObject([{ rowsOut: 4 }]);
  expect(painted.some((s) => s.name === 'ui:hidden')).toBe(false);
  stop();
});

test('a frame that comes late is a frame gap, and the queue goes out on a timer', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  const start = performance.now();
  const stop = startPerfMeter();
  for (const at of [16, 33, 120, 136]) frames.shift()!(start + at);
  expect(invoked).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2000);
  expect(sent()).toEqual([{ name: 'ui:frame gap', ms: 87, rowsIn: undefined, rowsOut: undefined }]);
  stop();
  vi.unstubAllGlobals();
});

test('the report sends what is queued first', async () => {
  invoked.mockImplementation(async (cmd) => (cmd === 'perf_report' ? { ops: [], slowest: [] } : undefined));
  record('queued', 1);
  expect(await perf.report()).toEqual({ ops: [], slowest: [] });
  expect(invoked.mock.calls.map(([cmd]) => cmd)).toEqual(['perf_record', 'perf_report']);
});
