import { expect, test, vi } from 'vitest';
import { doc, type DocChanged } from '../platform/document';
import { watchFramesAfterAction } from '../platform/perf';
import { boardStore } from './boardStore';

vi.mock('../platform/document', () => ({ doc: { listen: vi.fn(async () => () => {}) } }));
vi.mock('../storage', () => ({
  storage: {
    init: vi.fn(async () => {}),
    listBoards: vi.fn(async () => []),
    gcMedia: vi.fn(async () => 0),
  },
}));
vi.mock('../platform/perf', async (actual) => ({
  ...(await actual<typeof import('../platform/perf')>()),
  watchFramesAfterAction: vi.fn(),
}));

test('a change landing from the shell starts the frame watch', async () => {
  await boardStore.getState().init();
  const handler = vi.mocked(doc.listen).mock.calls[0][0];
  expect(watchFramesAfterAction).not.toHaveBeenCalled();
  handler({ boardId: 'brd_x', cards: [], connections: [], clusters: [], removedCards: [], removedConnections: [], removedClusters: [], canUndo: false, canRedo: false } as DocChanged);
  expect(watchFramesAfterAction).toHaveBeenCalledTimes(1);
});
