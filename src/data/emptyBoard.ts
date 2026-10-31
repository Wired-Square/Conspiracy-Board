import type { Board } from '../types/board';

/** What an unnamed board is called, wherever that has to be spelled out. */
export const DEFAULT_BOARD_TITLE = 'Untitled board';

/** A blank board, for `New`. */
export function emptyBoard(): Board {
  return {
    version: 4,
    meta: { title: DEFAULT_BOARD_TITLE, updatedAt: new Date().toISOString() },
    clusters: [],
    cards: [],
    connections: [],
  };
}
