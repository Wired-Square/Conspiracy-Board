import { useMemo } from 'react';
import { buildRoster, type Roster } from '../lib/roster';
import { useBoardStore } from '../store/boardStore';

/**
 * The participant graph for the current board, built once per change to the
 * cards and shared by every consumer — the canvas, the editor, the import
 * modal. Derived at render and never stored, like every other derived view here.
 *
 * It rebuilds on any change to `cards` — a drag *settling*, an edit committing
 * (onNodesChange holds `cards` still mid-drag and folds positions in on
 * release). buildRoster is one pass — a few thousand map operations on a large
 * board, well inside a frame — so this is left honest rather than made clever.
 * If it ever does bite, the answer is not a smarter memo key (computing one is
 * itself O(cards)): it is to hold the roster in the store and rebuild it in
 * the three mutators that can change participants. That trades away "derived
 * at render", so it wants a measurement first, not a hunch.
 */
export function useRoster(): Roster {
  const cards = useBoardStore((s) => s.cards);
  return useMemo(() => buildRoster(cards), [cards]);
}
