import { useMemo } from 'react';
import { suggestedLinks, type Roster } from '../lib/roster';
import type { StringEdge } from '../types/reactflow';

/** One array, so a board with no derived links hands back the same reference. */
const NONE: StringEdge[] = [];

/**
 * Every derived link between the visible cards, as edges React Flow can draw —
 * the whole board's worth, not just the focused card's, so the strings are there
 * to read without hovering a card first.
 *
 * Which pairs those are is lib/roster's `suggestedLinks`, asked once per card;
 * participation is symmetric, so each pair turns up twice and is deduped to a
 * single edge with a stable, order-independent id. Emails are not drawn on the
 * board, so in practice these are the person↔organisation ties — by shared
 * domain or by a shared message (see buildRoster).
 *
 * These edges cannot reach disk. They are built here, at render, and never enter
 * `boardStore.connections` — which is what `toBoard()` persists.
 *
 * They are not selectable, focusable or deletable: a suggestion is not a thing
 * you can grade, label or cut. To assert one, the user draws a real Connection,
 * which carries its own grade (see lib/roster.ts on what the derivations are
 * worth).
 */
export function useParticipantEdges(
  roster: Roster,
  visibleNodeIds: Set<string>,
  edges: StringEdge[],
): StringEdge[] {
  return useMemo(() => {
    const seen = new Set<string>();
    const derived: StringEdge[] = [];

    for (const id of visibleNodeIds) {
      for (const otherId of suggestedLinks(roster, id, visibleNodeIds, edges)) {
        // One edge per unordered pair: the lower id is the source, so the two
        // directions collapse to the same key and the same edge.
        const [a, b] = id < otherId ? [id, otherId] : [otherId, id];
        const key = `${a}:${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        derived.push({
          id: `derived:${key}`,
          source: a,
          target: b,
          type: 'redString',
          data: { variant: 'participant' },
          selectable: false,
          focusable: false,
          deletable: false,
        });
      }
    }

    return derived.length ? derived : NONE;
  }, [roster, visibleNodeIds, edges]);
}
