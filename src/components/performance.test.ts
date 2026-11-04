// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import type { PerfReport } from '../bindings/PerfReport';
import { perf } from '../platform/perf';
import { perfText } from '../lib/perfText';
import { PerformanceModal } from './panels/PerformanceModal';

const size = (rowsIn: number, rowsOut: number, bytes: number) => ({ rowsIn, rowsOut, bytes });
const REPORT: PerfReport = {
  ops: [
    { name: 'emit doc:changed', count: 2, p50Ms: 400, p95Ms: 900, maxMs: 900, lastMs: 400, lastSize: size(0, 1, 812) },
    { name: 'ui:frame gap', count: 1, p50Ms: 60, p95Ms: 60, maxMs: 60, lastMs: 60, lastSize: size(0, 0, 0) },
  ],
  slowest: [{ name: 'open_board_session', ms: 900, at: 0, rowsIn: 0, rowsOut: 11034, bytes: 0 }],
};
const EMPTY: PerfReport = { ops: [], slowest: [] };

vi.mock('../platform/perf', () => ({ perf: { report: vi.fn(), reset: vi.fn(async () => {}) } }));
const mocked = vi.mocked(perf);
const writeText = vi.fn(async () => {});
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

let dispose: (() => void) | undefined;
function mount() {
  const host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(PerformanceModal, {}), host);
  return host;
}
const settle = () => new Promise((r) => setTimeout(r));
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
const cells = (host: HTMLElement, table: number) =>
  [...host.querySelectorAll('table')[table].querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

test('the panel lists each operation slowest first, then the slowest calls with their sizes', async () => {
  mocked.report.mockResolvedValue(REPORT);
  const host = mount();
  await settle();
  expect(cells(host, 0)).toEqual([
    ['emit doc:changed', '2', '400.0', '900.0', '900.0', '400.0', '812'],
    ['ui:frame gap', '1', '60.0', '60.0', '60.0', '60.0', '0'],
  ]);
  expect(cells(host, 1)[0].slice(1)).toEqual(['open_board_session', '900.0', '0', '11034', '0']);
});

test('Reset clears the meter and shows it empty, and Copy puts the text on the clipboard', async () => {
  mocked.report.mockResolvedValue(REPORT);
  const host = mount();
  await settle();
  button(host, 'Copy as text').click();
  await settle();
  expect(writeText).toHaveBeenCalledWith(perfText(REPORT));

  mocked.report.mockResolvedValue(EMPTY);
  button(host, 'Reset').click();
  await settle();
  expect(mocked.reset).toHaveBeenCalledTimes(1);
  expect(host.querySelector('table')).toBeNull();
  expect(host.textContent).toContain('Nothing timed yet.');
});

test('a report that fails says why', async () => {
  mocked.report.mockRejectedValue(new Error('The meter is unavailable.'));
  const host = mount();
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The meter is unavailable.');
});
