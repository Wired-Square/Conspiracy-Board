// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { startInputModality } from './inputModality';

test('a key press marks keyboard modality until the next pointer press; Escape and a shortcut do not', () => {
  const root = document.documentElement;
  const stop = startInputModality();
  expect(root.dataset.modality).toBeUndefined();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(root.dataset.modality).toBeUndefined();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  expect(root.dataset.modality).toBe('keyboard');

  window.dispatchEvent(new Event('pointerdown'));
  expect(root.dataset.modality).toBeUndefined();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  stop();
  expect(root.dataset.modality).toBeUndefined();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  expect(root.dataset.modality).toBeUndefined();
});
