// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { pushModal } from './modalStack';

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

test('Escape closes only the top-most modal, then the one beneath once it is gone', () => {
  const lower = vi.fn();
  const upper = vi.fn();
  const removeLower = pushModal(lower);
  const removeUpper = pushModal(upper);

  escape();
  expect(upper).toHaveBeenCalledTimes(1);
  expect(lower).not.toHaveBeenCalled();

  removeUpper();
  escape();
  expect(lower).toHaveBeenCalledTimes(1);

  removeLower();
  escape();
  expect(lower).toHaveBeenCalledTimes(1);
});

test('a top modal closed by its own Escape does not let the same keypress reach the next', () => {
  const lower = vi.fn();
  let removeUpper = () => {};
  const removeLower = pushModal(lower);
  removeUpper = pushModal(() => removeUpper());

  escape();
  expect(lower).not.toHaveBeenCalled();
  removeLower();
});
