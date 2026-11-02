// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { topDialog } from './dialogEscape';

const dialog = (open = true) => {
  const d = document.body.appendChild(document.createElement('dialog'));
  d.open = open;
  d.appendChild(document.createElement('button'));
  return d;
};
afterEach(() => document.body.replaceChildren());

test('the top dialog is the one holding focus, else the last open one', () => {
  const lower = dialog();
  const upper = dialog();
  dialog(false);
  expect(topDialog(window)).toBe(upper);
  expect(topDialog(lower.querySelector('button'))).toBe(lower);
});

test('Escape cancels only the top dialog, taking its default action, and nothing once a handler has taken it', () => {
  const lower = dialog();
  const upper = dialog();
  const cancelled = vi.fn((e: Event) => e.preventDefault());
  lower.addEventListener('cancel', cancelled);
  upper.addEventListener('cancel', cancelled);

  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  window.dispatchEvent(escape);
  expect(cancelled.mock.calls.map(([e]) => e.target)).toEqual([upper]);
  expect(escape.defaultPrevented).toBe(true);

  const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  taken.preventDefault();
  window.dispatchEvent(taken);
  expect(cancelled).toHaveBeenCalledOnce();
});

test('a cancel nobody prevents closes the dialog, as the platform would', () => {
  const only = dialog();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(only.open).toBe(false);
});
