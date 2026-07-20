import { useMemo, useRef } from 'react';
import { touches } from '../lib/connections';
import { isEntityKind } from '../lib/kinds';
import { actorScale } from '../lib/layout';
import type { CardNode, CardNodeData, StringEdge } from '../types/reactflow';

/**
 * Return display-ready nodes/edges: `hl`/`dim` classNames so the focused card
 * and its direct connections stand out, and React Flow's own `selected` flag so
 * the card draws its outline.
 *
 * **The two ids are deliberately separate.** `focusId` is what the board is
 * answering questions about — hovered, or selected when nothing is hovered — and
 * it drives highlight and dim. `selectedId` draws the outline and nothing else.
 * Merging them would let a hover move the editor, so passing over a card on the
 * way to somewhere else would throw away what you were reading.
 *
 * Both are derived here rather than stored, which keeps `selectedCardId` the
 * single source of truth — React Flow also writes `selected` onto store nodes
 * via applyNodeChanges, and deriving at render means that copy can never
 * disagree with the id the editor and timeline read.
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
  const degrees = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    }
    return d;
  }, [edges]);

  // Interned augmented data, per (store data, scale) pair. The nodes handed in
  // are always store-derived and never carry tieScale, so writing it with a
  // bare spread would mint a fresh `data` object on every pass and defeat
  // memo(EvidenceCardNode) for every actor on every hover and drag frame.
  // Interning makes the same store data + the same scale yield the *same*
  // object, so the memoised card bails exactly as it did before actors scaled.
  // WeakMap-keyed on the store data, so replaced cards collect with it.
  const dataCache = useRef(new WeakMap<CardNodeData, Map<number, CardNodeData>>());

  return useMemo(() => {
    const searching = matchIds !== null;
    const connectedEdgeIds = new Set<string>();
    const neighbourIds = new Set<string>();
    if (focusId) {
      neighbourIds.add(focusId);
      for (const e of edges) {
        if (touches(e, focusId)) {
          connectedEdgeIds.add(e.id);
          neighbourIds.add(e.source);
          neighbourIds.add(e.target);
        }
      }
    }

    // The one precedence rule, for nodes and edges alike: hl wins over dim; while
    // searching, `matched` owns the base dim (non-matches fade), otherwise focus
    // does (non-neighbours fade). `connected` is touching the focus; `matched` is
    // matching the search (both ends, for an edge).
    const classify = (connected: boolean, matched: boolean): string | undefined => {
      if (focusId && connected) return 'hl';
      const dim = searching ? !matched : !!focusId && !connected;
      return dim ? 'dim' : undefined;
    };

    // A paper face never scales, so its data passes through untouched; an
    // actor's data is the interned augmentation (see dataCache above).
    const dataFor = (data: CardNodeData, tieScale: number | undefined): CardNodeData => {
      if (tieScale === undefined) return data;
      let byScale = dataCache.current.get(data);
      if (!byScale) dataCache.current.set(data, (byScale = new Map()));
      let augmented = byScale.get(tieScale);
      if (!augmented) byScale.set(tieScale, (augmented = { ...data, tieScale }));
      return augmented;
    };

    // Preserve object identity when nothing about a node's presentation changed,
    // so memoised cards don't all re-render on every selection change or drag
    // frame. Cheap at 8 cards; not at the couple of hundred an mbox can add.
    const decoratedNodes = nodes.map((n) => {
      const className = classify(
        neighbourIds.has(n.id),
        matchIds !== null && matchIds.has(n.id),
      );
      const selected = n.id === selectedId;
      // Only the actors grow; the argument's paper stays one size.
      const data = dataFor(
        n.data,
        isEntityKind(n.data.card.kind) ? actorScale(degrees.get(n.id) ?? 0) : undefined,
      );
      return n.className === className && (n.selected ?? false) === selected && n.data === data
        ? n
        : { ...n, className, selected, data };
    });
    const decoratedEdges = edges.map((e) => {
      const className = classify(
        connectedEdgeIds.has(e.id),
        matchIds !== null && matchIds.has(e.source) && matchIds.has(e.target),
      );
      return e.className === className ? e : { ...e, className };
    });

    return { nodes: decoratedNodes, edges: decoratedEdges };
  }, [nodes, edges, degrees, focusId, selectedId, matchIds]);
}
