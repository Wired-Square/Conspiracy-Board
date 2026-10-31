import { expect, it } from 'vitest';
import { boardStore } from '../store/boardStore';
import { appOps } from './appOps';

it('board_summary counts what the open board holds', () => {
  boardStore.setState({
    currentBoardId: 'b1',
    meta: { title: 'The tender', updatedAt: '' },
    cards: [{}, {}, {}] as never,
    connections: [{}] as never,
    clusters: [{}, {}] as never,
  });
  expect(appOps.board_summary({})).toEqual({
    id: 'b1',
    title: 'The tender',
    cards: 3,
    connections: 1,
    clusters: 2,
  });
});
