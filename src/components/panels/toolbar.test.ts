// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { pushModal } from '../../lib/modalStack';
import { Toolbar } from './Toolbar';

vi.mock('../../storage', () => ({ storage: {} }));

const actions = { setView: vi.fn(), addCard: vi.fn(), setSearchQuery: vi.fn() };
let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  Object.values(actions).forEach((a) => a.mockClear());
  boardStore.setState({ ...actions, view: 'board', currentBoardId: 'b1', lastError: null });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(Toolbar, {}), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const trigger = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.menu__trigger')].find((b) => b.textContent?.startsWith(label))!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('.menu__item')];
const key = (target: EventTarget, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

test('the view chooser ticks the current view and switches on a pick, closing first', () => {
  trigger('Board').click();
  expect(trigger('Board').getAttribute('aria-expanded')).toBe('true');
  expect(items().map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  items()[1].click();
  expect(actions.setView).toHaveBeenCalledWith('record');
  expect(host.querySelector('.menu__list')).toBeNull();
});

test('a menu moves focus with the arrow keys and closes on an outside pointerdown', () => {
  key(trigger('+ Add'), 'ArrowDown');
  expect(document.activeElement).toBe(items()[0]);
  key(items()[0], 'ArrowDown');
  expect(document.activeElement?.textContent).toBe('Image');
  key(items()[1], 'End');
  expect(document.activeElement?.textContent).toBe('Cluster');
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(host.querySelector('.menu__list')).toBeNull();
});

test('Escape closes a menu over a dialog without closing the dialog', () => {
  const closeDialog = vi.fn();
  const pop = pushModal(closeDialog);
  trigger('+ Add').click();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(host.querySelector('.menu__list')).toBeNull();
  expect(document.activeElement).toBe(trigger('+ Add'));
  expect(closeDialog).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(closeDialog).toHaveBeenCalledOnce();
  pop();
});

test('the search box writes the store once typing settles, and clears on a board switch', () => {
  vi.useFakeTimers();
  const search = host.querySelector<HTMLInputElement>('.toolbar__search')!;
  actions.setSearchQuery.mockClear();
  search.value = 'mal';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(100);
  expect(actions.setSearchQuery).not.toHaveBeenCalled();
  vi.advanceTimersByTime(50);
  expect(actions.setSearchQuery).toHaveBeenLastCalledWith('mal');
  boardStore.setState({ currentBoardId: 'b2' });
  expect(search.value).toBe('');
  vi.advanceTimersByTime(150);
  expect(actions.setSearchQuery).toHaveBeenLastCalledWith('');
});

test('Tidy shows only on the board, and the objects view swaps + Add for its badge', () => {
  const tidy = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Tidy');
  expect(tidy()).toBeDefined();
  boardStore.setState({ view: 'object' });
  expect(tidy()).toBeUndefined();
  expect(trigger('+ Add')).toBeUndefined();
  expect(host.querySelector('.objects-badge')?.textContent).toContain('Objects');
});
