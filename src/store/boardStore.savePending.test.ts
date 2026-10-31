import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardStore } from './boardStore';

const pending = () => boardStore.getState().savePending;
const pan = () => boardStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });

describe('savePending', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds from a scheduled autosave until the save lands', async () => {
    vi.useFakeTimers();
    pan();
    expect(pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(pending()).toBe(false);
  });

  it('is released by flushSaves without waiting out the debounce', async () => {
    vi.useFakeTimers();
    pan();
    await boardStore.getState().flushSaves();
    expect(pending()).toBe(false);
  });
});
