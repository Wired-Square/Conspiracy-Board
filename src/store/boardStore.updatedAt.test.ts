import { afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '../storage';
import { boardStore } from './boardStore';
import type { Card } from '../types/board';

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

describe('a change that changes nothing is not an edit', () => {
  const card = { id: 'card_a', title: 'A', position: { x: 1, y: 2 } } as Card;

  async function savesAfter(act: () => void) {
    vi.useFakeTimers();
    const saveBoard = vi.spyOn(storage, 'saveBoard').mockResolvedValue();
    boardStore.setState({ currentBoardId: 'brd_test', cards: [card] });
    act();
    await vi.advanceTimersByTimeAsync(500);
    return saveBoard.mock.calls.length;
  }

  it('settling a card where it already is', async () => {
    expect(await savesAfter(() => boardStore.getState().arrangeCards(new Map([['card_a', { x: 1, y: 2 }]])))).toBe(0);
  });

  it('committing a field with its current value', async () => {
    expect(await savesAfter(() => boardStore.getState().updateCard('card_a', { title: 'A' }))).toBe(0);
  });
});
