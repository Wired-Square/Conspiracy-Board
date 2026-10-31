import { useMemo, useState } from 'react';
import { highlight, linkDegrees, tieScaleInterner } from '../lib/highlight';
import type { CardNode, CardNodeData, StringEdge } from '../types/canvas';

/**
 * Return display-ready nodes/edges: `hl`/`dim` classNames so the focused card
 * and its direct connections stand out, and a `selected` flag so the card draws
 * its outline.
 *
 * **The two ids are deliberately separate.** `focusId` is what the board is
 * answering questions about — hovered, or selected when nothing is hovered — and
 * it drives highlight and dim. `selectedId` draws the outline and nothing else.
 * Merging them would let a hover move the editor, so passing over a card on the
 * way to somewhere else would throw away what you were reading.
 *
 * Both are derived here rather than stored, which keeps `selectedCardId` the
 * single source of truth: the flag can never disagree with the id the editor
 * and timeline read.
 *
 * The derived participant edges are already in `edges` when this runs, treated
 * no differently from real ones: the neighbour pass un-dims the far end of any
 * edge touching `focusId`, and dims the rest, derived or drawn alike.
 *
 * **Search composes on top of focus.** `matchIds` is the set of cards matching
 * the current query, or null when nothing is being searched. When it is present
 * it owns the base dim — everything not matched dims — and focus still overlays
 * `hl`, so a card you point at keeps itself and its neighbours lit and its
 * strings traceable even mid-search. With `matchIds` null this is exactly the
 * focus-only behaviour it always was.
 *
 * It also writes each actor's `tieScale` — the polaroid grows with how
 * connected the actor is. Sized from the same `edges` the board draws (string
 * and derived participant links alike), so what you see is what is counted;
 * it lives in this pass because the edge set is only assembled here, and the
 * identity-preservation below already exists to make per-node decoration
 * cheap. Keyed on `edges` alone, so hovering never re-derives it.
 */
export function useHighlightConnections(
  nodes: CardNode[],
  edges: StringEdge[],
  focusId: string | null,
  selectedId: string | null,
  matchIds: Set<string> | null,
): { nodes: CardNode[]; edges: StringEdge[] } {
  const degrees = useMemo(() => linkDegrees(edges), [edges]);
  // The nodes handed in are always store-derived and never carry tieScale, so
  // writing it with a bare spread would mint a fresh `data` object on every pass
  // and defeat memo(EvidenceCard) for every actor on every hover and drag frame.
  const [dataFor] = useState(() => tieScaleInterner<CardNodeData>());
  return useMemo(
    () => highlight(nodes, edges, { focusId, selectedId, matchIds, degrees }, dataFor),
    [nodes, edges, degrees, focusId, selectedId, matchIds, dataFor],
  );
}
