import { afterEach, expect, it, vi } from 'vitest';
import { storage } from '../storage';
import { boardStore } from './boardStore';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('a pan after an edit keeps the edit stamp rather than the loaded one', async () => {
  vi.useFakeTimers();
  const saved: string[] = [];
  vi.spyOn(storage, 'saveBoard').mockImplementation(async (_id, board) => {
    saved.push(board.meta.updatedAt);
  });
  boardStore.setState({ currentBoardId: 'brd_test', meta: { title: 'T', updatedAt: '2020-01-01T00:00:00.000Z' } });

  boardStore.getState().setTitle('Edited');
  await vi.advanceTimersByTimeAsync(500);
  boardStore.getState().setViewport({ x: 1, y: 2, zoom: 1 });
  await vi.advanceTimersByTimeAsync(500);

  expect(saved).toHaveLength(2);
  expect(saved[0]).not.toBe('2020-01-01T00:00:00.000Z');
  expect(saved[1]).toBe(saved[0]);
});
