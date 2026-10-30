import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBoardStore } from './boardStore';

const pending = () => useBoardStore.getState().savePending;
const pan = () => useBoardStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });

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
    await useBoardStore.getState().flushSaves();
    expect(pending()).toBe(false);
  });
});
