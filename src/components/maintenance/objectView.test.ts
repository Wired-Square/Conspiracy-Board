// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { jobsStore } from '../../store/jobsStore';
import { mediaAuditStore } from '../../store/mediaAuditStore';
import type { MediaRow } from '../../lib/maintenance';
import { ObjectView } from './ObjectView';

const { storage } = vi.hoisted(() => ({
  storage: {
    indexStatuses: vi.fn(async () => [{ name: 'scan.pdf', status: 'failed' }]),
    verifyMedia: vi.fn(async () => true),
    extractMediaMeta: vi.fn(async () => ({ title: 'Ledger' })),
    searchDocuments: vi.fn(async () => []),
  },
}));
vi.mock('../../storage', () => ({ storage }));
vi.mock('../../storage/media', () => ({ mediaSrc: (name: string) => `media/${name}` }));

const rows: MediaRow[] = [
  { file: 'scan.pdf', size: 2048, onDisk: true, status: 'ok', owner: { cardId: 'c1', title: 'Scan', cardKind: 'document', mediaKind: 'document' } },
  { file: 'stray.png', size: 10, onDisk: true, status: 'orphan', owner: null },
];
const refresh = vi.fn(async () => {});
const reprocessCard = vi.fn(async (_id: string) => {});
const setStatus = vi.fn((status: string | null) => mediaAuditStore.setState({ status }));

let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  jobsStore.setState({ pending: 0 });
  boardStore.setState({ searchQuery: '', reprocessCard });
  mediaAuditStore.setState({ rows, loading: false, error: null, incomplete: false, status: null, refresh, setStatus });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => ObjectView(), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

const settle = () => new Promise((r) => setTimeout(r));
const row = (file: string) => [...host.querySelectorAll<HTMLElement>('.maintenance-row')].find((r) => r.textContent?.includes(file))!;
const button = (within: HTMLElement, text: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(text))!;

test('audits on mount and badges each row with its index status', async () => {
  expect(refresh).toHaveBeenCalledOnce();
  await settle();
  expect(row('Scan').textContent).toContain('index failed');
  expect(button(row('stray.png'), 'Add as card')).toBeDefined();
});

test('Verify marks the row, and a row survives a re-audit', async () => {
  const scan = row('Scan');
  button(scan, 'Verify').click();
  await settle();
  expect(storage.verifyMedia).toHaveBeenCalledWith('scan.pdf');
  expect(scan.textContent).toContain('verified ✓');
  mediaAuditStore.setState({ rows: rows.map((r) => ({ ...r })) });
  expect(row('Scan')).toBe(scan);
});

test('Reprocess runs with the status line up and re-audits after', async () => {
  const warn = vi.spyOn(console, 'warn');
  button(row('Scan'), 'Reprocess').click();
  expect(setStatus).toHaveBeenCalledWith('Reprocessing…');
  await settle();
  expect(reprocessCard).toHaveBeenCalledWith('c1');
  expect(setStatus).toHaveBeenLastCalledWith(null);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test('the Maintenance menu filters to issues', () => {
  button(host, 'Maintenance').click();
  button(host, 'Only issues').click();
  expect(host.querySelectorAll('.maintenance-row')).toHaveLength(1);
  expect(row('stray.png')).toBeDefined();
});

test('Details opens the file dialog over the view, and Escape closes it', async () => {
  button(row('Scan'), 'Details').click();
  await settle();
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('Scan');
  expect(dialog.textContent).toContain('Ledger');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test('the toolbar search narrows the list and says when nothing matches', () => {
  boardStore.setState({ searchQuery: 'nothing like it' });
  expect(host.querySelector('.record__empty')?.textContent).toBe('No objects match “nothing like it”.');
});
