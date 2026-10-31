// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createComponent, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { dialogStore, openDialog } from '../../store/dialogStore';
import { promptStore } from '../../store/promptStore';
import type { Board } from '../../types/board';
import { BoardPropertiesModal } from './BoardPropertiesModal';
import { ManageModal } from './ManageModal';
import { BundleExportModal } from './BundleExportModal';
import { BundleImportModal } from './BundleImportModal';

// These four open only from the native File menu (or its file picker), which the
// dev MCP can't drive, so they are walked here instead.
vi.mock('../../storage', () => ({
  storage: {
    boardLocation: vi.fn(async (id: string) => `/library/boards/${id}.json`),
    revealBoard: vi.fn(async () => {}),
    listBoards: vi.fn(async () => [
      { id: 'b1', title: 'First' },
      { id: 'b2', title: 'Second' },
    ]),
  },
}));

let dispose: (() => void) | undefined;
function mount<P extends object>(component: Component<P>, props: P) {
  const host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(component, props), host);
  return host;
}
const settle = () => new Promise((r) => setTimeout(r));
const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const typeInto = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  boardStore.setState({
    currentBoardId: 'b1',
    meta: { ...boardStore.getState().meta, title: 'Live title', countryCode: '+61' },
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

test('board properties focuses the title, commits it after typing pauses, and closes on Escape or Close', async () => {
  const setTitle = vi.fn();
  boardStore.setState({ setTitle });
  const onClose = vi.fn();
  const host = mount(BoardPropertiesModal, { onClose });
  const title = host.querySelector('input')!;
  await settle();
  expect(document.activeElement).toBe(title);
  expect(title.value).toBe('Live title');
  expect(host.querySelector('.board-file')?.textContent).toBe('/library/boards/b1.json');

  vi.useFakeTimers();
  typeInto(title, 'Renamed');
  expect(setTitle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  expect(setTitle).toHaveBeenCalledWith('Renamed');

  escape();
  button(host, 'Close').click();
  expect(onClose).toHaveBeenCalledTimes(2);
});

test('manage renames through the shared prompt and closes its dialog slot', async () => {
  const setTitle = vi.fn();
  boardStore.setState({ setTitle });
  openDialog({ manage: true });
  const host = mount(ManageModal, {});
  expect(host.querySelector('.manage__name')?.textContent).toBe('Live title');

  button(host, 'Rename').click();
  const request = promptStore.getState().request;
  expect(request?.kind === 'text' && request.initialValue).toBe('Live title');
  if (request?.kind === 'text') request.resolve('New name');
  await settle();
  expect(setTitle).toHaveBeenCalledWith('New name');

  escape();
  expect(dialogStore.getState().manage).toBe(false);
});

test('bundle export preselects the current board and stays open when the save is cancelled', async () => {
  const exportBundle = vi.fn(async () => false);
  boardStore.setState({ exportBundle });
  openDialog({ bundleExport: true });
  const host = mount(BundleExportModal, {});
  await settle();
  const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  expect(boxes().map((b) => b.checked)).toEqual([false, true, false]);
  expect(host.querySelector('ul .import-offer__label')?.textContent).toBe('Live title');

  boxes()[0].click();
  expect(boxes().map((b) => b.checked)).toEqual([true, true, true]);
  button(host, 'Export').click();
  await settle();
  expect(exportBundle).toHaveBeenCalledWith(['b1', 'b2']);
  expect(dialogStore.getState().bundleExport).toBe(true);

  exportBundle.mockResolvedValueOnce(true);
  button(host, 'Export').click();
  await settle();
  expect(dialogStore.getState().bundleExport).toBe(false);
});

test('bundle import adopts only the ticked boards, under their edited names', async () => {
  const adoptBundle = vi.fn(async () => {});
  boardStore.setState({ adoptBundle });
  const boards = [{ meta: { title: 'One' } }, { meta: { title: '' } }] as Board[];
  openDialog({ bundleImportBoards: boards });
  const host = mount(BundleImportModal, { boards });
  const names = [...host.querySelectorAll<HTMLInputElement>('.import-offer__rename')];
  expect(names.map((n) => n.value)).toEqual(['One', 'Untitled board']);

  typeInto(names[1], '  Two  ');
  expect(document.contains(names[1])).toBe(true);
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  expect(host.querySelector('.modal__status')?.textContent).toBe('1 of 2 boards selected');

  button(host, 'Import').click();
  await settle();
  expect(adoptBundle).toHaveBeenCalledWith([{ board: boards[1], title: 'Two' }]);
  expect(dialogStore.getState().bundleImportBoards).toBe(null);
});
