import { useMemo } from 'react';
import { touches } from '../lib/connections';
import type { CardNode, StringEdge } from '../types/reactflow';

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
 */
export function useHighlightConnections(
  nodes: CardNode[],
  edges: StringEdge[],
  focusId: string | null,
  selectedId: string | null,
  matchIds: Set<string> | null,
): { nodes: CardNode[]; edges: StringEdge[] } {
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

    // Preserve object identity when nothing about a node's presentation changed,
    // so memoised cards don't all re-render on every selection change or drag
    // frame. Cheap at 8 cards; not at the couple of hundred an mbox can add.
    const decoratedNodes = nodes.map((n) => {
      const className = classify(
        neighbourIds.has(n.id),
        matchIds !== null && matchIds.has(n.id),
      );
      const selected = n.id === selectedId;
      return n.className === className && (n.selected ?? false) === selected
        ? n
        : { ...n, className, selected };
    });
    const decoratedEdges = edges.map((e) => {
      const className = classify(
        connectedEdgeIds.has(e.id),
        matchIds !== null && matchIds.has(e.source) && matchIds.has(e.target),
      );
      return e.className === className ? e : { ...e, className };
    });

    return { nodes: decoratedNodes, edges: decoratedEdges };
  }, [nodes, edges, focusId, selectedId, matchIds]);
}
