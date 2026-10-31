import { createStore } from 'zustand/vanilla';
import type { Card, Cluster, Connection } from '../../types/board';
import type { CardNode, StringEdge, StringEdgeData } from '../../types/canvas';
import { clusterColor, extraClusterColors, primaryClusterId } from '../../lib/clusters';
import { boardStore } from '../../store/boardStore';

// The board as the canvas sees it: nodes and edges derived from the store's
// cards and connections, each reused while what it was built from is unchanged.

/** Build a derived canvas node for a card, resolving its cluster colours. */
export function cardToNode(card: Card, clusters: Cluster[]): CardNode {
  return {
    id: card.id,
    ...card.position,
    data: {
      card,
      clusterColor: clusterColor(primaryClusterId(card.clusterIds), clusters),
      extraClusterColors: extraClusterColors(card.clusterIds, clusters),
    },
  };
}

// The connection each edge's data was built from, so an untouched connection
// keeps its edge.
const edgeSource = new WeakMap<StringEdgeData, Connection>();

export function connectionToEdge(c: Connection): StringEdge {
  // Carrying `kind` and `grade` through is what lets a graded link look
  // different from an assumed one.
  const data: StringEdgeData = { label: c.label, kind: c.kind, grade: c.grade };
  edgeSource.set(data, c);
  return { id: c.id, source: c.source, target: c.target, data };
}

const samePosition = (node: CardNode, p: Card['position']) => node.x === p.x && node.y === p.y;

function sameExceptPosition(a: Card, b: Card): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Card>;
  for (const k of keys) if (k !== 'position' && a[k] !== b[k]) return false;
  return true;
}

const sameColours = (a: CardNode['data'], b: CardNode['data']) =>
  a.clusterColor === b.clusterColor &&
  a.extraClusterColors.length === b.extraClusterColors.length &&
  a.extraClusterColors.every((c, i) => c === b.extraClusterColors[i]);

/** `next`, or `prev` itself when every element is the same object. */
const keepIfSame = <T,>(prev: T[], next: T[]): T[] =>
  next.length === prev.length && next.every((x, i) => x === prev[i]) ? prev : next;

/**
 * The nodes for `cards`, reusing each previous node whose card and colours are
 * unchanged, so the memoised card faces don't re-render.
 */
export function reconcileNodes(
  prev: CardNode[],
  prevClusters: Cluster[],
  cards: Card[],
  clusters: Cluster[],
): CardNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return keepIfSame(
    prev,
    cards.map((card) => {
      const node = prevById.get(card.id);
      if (!node) return cardToNode(card, clusters);
      const was = node.data.card;
      const fresh = clusters === prevClusters && card.clusterIds === was.clusterIds ? null : cardToNode(card, clusters);
      if (fresh && !sameColours(fresh.data, node.data)) return fresh;
      if (card === was) return node;
      if (!sameExceptPosition(card, was)) return fresh ?? cardToNode(card, clusters);
      return samePosition(node, card.position) ? node : { ...node, ...card.position, data: { ...node.data, card } };
    }),
  );
}

/** The edges for `connections`, reusing each edge whose connection is unchanged. */
export function reconcileEdges(prev: StringEdge[], connections: Connection[]): StringEdge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return keepIfSame(
    prev,
    connections.map((c) => {
      const edge = prevById.get(c.id);
      return edge && edgeSource.get(edge.data) === c ? edge : connectionToEdge(c);
    }),
  );
}

type ProjectionState = { nodes: CardNode[]; edges: StringEdge[] };

export const projectionStore = createStore<ProjectionState>()(() => {
  const { cards, clusters, connections } = boardStore.getState();
  return { nodes: reconcileNodes([], clusters, cards, clusters), edges: reconcileEdges([], connections) };
});

// Synchronous, so a render never sees cards and nodes out of step.
const unsubscribe = boardStore.subscribe((s, prev) => {
  const projection = projectionStore.getState();
  const nodes =
    s.cards !== prev.cards || s.clusters !== prev.clusters
      ? reconcileNodes(projection.nodes, prev.clusters, s.cards, s.clusters)
      : projection.nodes;
  const edges = s.connections !== prev.connections ? reconcileEdges(projection.edges, s.connections) : projection.edges;
  if (nodes !== projection.nodes || edges !== projection.edges) projectionStore.setState({ nodes, edges });
});
import.meta.hot?.dispose(unsubscribe);
