import type { Board } from '../types/board';

/** What an unnamed board is called, wherever that has to be spelled out. */
export const DEFAULT_BOARD_TITLE = 'Untitled board';

/**
 * A blank board, for `New`.
 *
 * Deliberately not in defaultBoard.ts: that module does a top-level import of
 * data/board.json and is dynamic-imported precisely to keep the seed content out
 * of the main chunk. Creating an empty board must not drag it back in.
 */
export function emptyBoard(): Board {
  return {
    version: 4,
    meta: { title: DEFAULT_BOARD_TITLE, updatedAt: new Date().toISOString() },
    clusters: [],
    cards: [],
    connections: [],
  };
}
