// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { maskStore } from '../store/maskStore';
import { MASK_IDLE_MS, startMaskIdle } from './maskIdle';

vi.mock('../storage', () => ({ storage: {} }));

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  maskStore.setState({ mask: true });
  stop = startMaskIdle();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const mask = () => maskStore.getState().mask;

it('turns Mask back on after fifteen minutes without input', () => {
  maskStore.getState().setMask(false);
  vi.advanceTimersByTime(MASK_IDLE_MS - 1);
  expect(mask()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(mask()).toBe(true);
});

it('counts the fifteen minutes from the last input', () => {
  maskStore.getState().setMask(false);
  vi.advanceTimersByTime(MASK_IDLE_MS - 1000);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  vi.advanceTimersByTime(MASK_IDLE_MS - 1);
  expect(mask()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(mask()).toBe(true);
});

it('starts counting afresh each time Mask goes off', () => {
  vi.advanceTimersByTime(MASK_IDLE_MS * 2);
  maskStore.getState().setMask(false);
  vi.advanceTimersByTime(MASK_IDLE_MS - 1);
  expect(mask()).toBe(false);
});
