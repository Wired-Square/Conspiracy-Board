import type { CardKind } from '../types/board';
import { touches } from './connections';
import { isEntityKind } from './kinds';
import { actorScale } from './layout';

// The board's focus and search pass, independent of the canvas library: which
// cards and strings light up, which dim, and how far each actor grows.

type HighlightNode = { id: string; className?: string; selected?: boolean; data: { card: { kind: CardKind } } };
type HighlightEdge = { id: string; source: string; target: string; className?: string };

/** How many links touch each card. */
export function linkDegrees(links: { source: string; target: string }[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const l of links) {
    d.set(l.source, (d.get(l.source) ?? 0) + 1);
    d.set(l.target, (d.get(l.target) ?? 0) + 1);
  }
  return d;
}

/**
 * The one precedence rule, for nodes and edges alike: hl wins over dim; while
 * searching, `matched` owns the base dim (non-matches fade), otherwise focus
 * does (non-neighbours fade). `connected` is touching the focus; `matched` is
 * matching the search (both ends, for an edge).
 */
export function highlightClass(
  focused: boolean,
  searching: boolean,
  connected: boolean,
  matched: boolean,
): 'hl' | 'dim' | undefined {
  if (focused && connected) return 'hl';
  const dim = searching ? !matched : focused && !connected;
  return dim ? 'dim' : undefined;
}

/**
 * Interns data augmented with a tie scale, so the same data and the same scale
 * yield the *same* object and a memoised card face bails. Data without a scale
 * passes through. Keyed weakly on the data, so replaced cards collect with it.
 */
export function tieScaleInterner<D extends object>(): (data: D, tieScale: number | undefined) => D {
  const cache = new WeakMap<D, Map<number, D>>();
  return (data, tieScale) => {
    if (tieScale === undefined) return data;
    let byScale = cache.get(data);
    if (!byScale) cache.set(data, (byScale = new Map()));
    let augmented = byScale.get(tieScale);
    if (!augmented) byScale.set(tieScale, (augmented = { ...data, tieScale }));
    return augmented;
  };
}

export type HighlightInput = {
  focusId: string | null;
  selectedId: string | null;
  matchIds: Set<string> | null;
  degrees: Map<string, number>;
};

/**
 * Nodes and edges with their `hl`/`dim` class, the node's `selected` flag and
 * each actor's tie scale. An element whose presentation is unchanged comes back
 * as the same object, so memoised cards don't all re-render on every selection
 * change or drag frame.
 */
export function highlight<N extends HighlightNode, E extends HighlightEdge>(
  nodes: N[],
  edges: E[],
  { focusId, selectedId, matchIds, degrees }: HighlightInput,
  dataFor: (data: N['data'], tieScale: number | undefined) => N['data'],
): { nodes: N[]; edges: E[] } {
  const focused = !!focusId;
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

  return {
    nodes: nodes.map((n) => {
      const className = highlightClass(focused, searching, neighbourIds.has(n.id), !!matchIds?.has(n.id));
      const selected = n.id === selectedId;
      // Only the actors grow; the argument's paper stays one size.
      const data = dataFor(n.data, isEntityKind(n.data.card.kind) ? actorScale(degrees.get(n.id) ?? 0) : undefined);
      return n.className === className && (n.selected ?? false) === selected && n.data === data
        ? n
        : { ...n, className, selected, data };
    }),
    edges: edges.map((e) => {
      const className = highlightClass(
        focused,
        searching,
        connectedEdgeIds.has(e.id),
        !!matchIds?.has(e.source) && matchIds.has(e.target),
      );
      return e.className === className ? e : { ...e, className };
    }),
  };
}
