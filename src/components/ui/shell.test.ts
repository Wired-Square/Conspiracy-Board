// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createComponent, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { prompt } from '../../store/promptStore';
import { PromptHost } from './PromptModal';
import { UndoToast } from './UndoToast';

let dispose: (() => void) | undefined;
function mount(component: Component) {
  const host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(component, {}), host);
  return host;
}
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const input = (host: HTMLElement) => host.querySelector('input')!;
const typeInto = (host: HTMLElement, value: string) => {
  input(host).value = value;
  input(host).dispatchEvent(new Event('input', { bubbles: true }));
};

test('a text prompt opens prefilled and focused, and Enter resolves the trimmed text', async () => {
  const host = mount(PromptHost);
  const answer = prompt({ title: 'Rename', initialValue: 'Old' });
  expect(input(host).value).toBe('Old');
  expect(document.activeElement).toBe(input(host));

  typeInto(host, '  New  ');
  input(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(await answer).toBe('New');
  expect(host.querySelector('.modal')).toBeNull();
});

test('a request that displaces another cancels it and opens with fresh input', async () => {
  const host = mount(PromptHost);
  const first = prompt({ title: 'First', initialValue: 'a' });
  typeInto(host, 'typed');

  const second = prompt({ title: 'Second', initialValue: 'b' });
  expect(await first).toBeNull();
  expect(input(host).value).toBe('b');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(await second).toBeNull();
});

test('the undo toast shows each delete and hides ten seconds after the last', () => {
  vi.useFakeTimers();
  const host = mount(UndoToast);
  boardStore.setState({ lastDeleted: { kind: 'card', id: 'c1', label: 'Memo' } });
  expect(host.textContent).toContain('Deleted “Memo”');

  vi.advanceTimersByTime(6_000);
  boardStore.setState({ lastDeleted: { kind: 'cluster', id: 'k1', label: '' } });
  vi.advanceTimersByTime(6_000);
  expect(host.textContent).toContain('Deleted cluster “Untitled”');

  vi.advanceTimersByTime(4_000);
  expect(host.textContent).toBe('');
});
