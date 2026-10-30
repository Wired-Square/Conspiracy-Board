import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection as FlowConnection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Card, Cluster, Connection } from '../../types/board';
import type { CardNode, StringEdge, StringEdgeData } from '../../types/reactflow';
import { clusterColor, extraClusterColors, primaryClusterId } from '../../lib/clusters';
import { boardStore } from '../../store/boardStore';

// The board as React Flow sees it. The store holds cards and connections; this
// derives the nodes and edges from them and folds React Flow's changes back.
// Nodes are kept here rather than derived per render because React Flow writes
// to them (measured size, a drag's live position), and a drag moves only the
// node: the card's position follows once it settles.

/** Build a derived React Flow node for a card, resolving its cluster colours. */
export function cardToNode(card: Card, clusters: Cluster[]): CardNode {
  return {
    id: card.id,
    type: 'evidenceCard',
    position: card.position,
    data: {
      card,
      clusterColor: clusterColor(primaryClusterId(card.clusterIds), clusters),
      extraClusterColors: extraClusterColors(card.clusterIds, clusters),
    },
  };
}

// The connection each edge's data was built from, so an untouched connection
// keeps its edge — React Flow's select changes copy the edge but keep its data.
const edgeSource = new WeakMap<StringEdgeData, Connection>();

export function connectionToEdge(c: Connection): StringEdge {
  // Carrying `kind` and `grade` through is what lets a graded link look
  // different from an assumed one.
  const data: StringEdgeData = { label: c.label, kind: c.kind, grade: c.grade };
  edgeSource.set(data, c);
  return { id: c.id, source: c.source, target: c.target, type: 'redString', data };
}

const samePosition = (a: Card['position'], b: Card['position']) => a.x === b.x && a.y === b.y;

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
 * unchanged, so the memoised card faces don't re-render. A card that only moved
 * keeps its node's measured size: a settled drag is already where the card is,
 * and Tidy moves just the position.
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
      return samePosition(node.position, card.position)
        ? node
        : { ...node, position: card.position, data: { ...node.data, card } };
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
      return edge?.data && edgeSource.get(edge.data) === c ? edge : connectionToEdge(c);
    }),
  );
}

type FlowState = { nodes: CardNode[]; edges: StringEdge[] };

export const flowStore = createStore<FlowState>()(() => {
  const { cards, clusters, connections } = boardStore.getState();
  return { nodes: reconcileNodes([], clusters, cards, clusters), edges: reconcileEdges([], connections) };
});

export const useFlowStore = <T,>(selector: (s: FlowState) => T): T => useStore(flowStore, selector);

// Synchronous, so a render never sees cards and nodes out of step.
const unsubscribe = boardStore.subscribe((s, prev) => {
  const flow = flowStore.getState();
  const nodes =
    s.cards !== prev.cards || s.clusters !== prev.clusters
      ? reconcileNodes(flow.nodes, prev.clusters, s.cards, s.clusters)
      : flow.nodes;
  const edges = s.connections !== prev.connections ? reconcileEdges(flow.edges, s.connections) : flow.edges;
  if (nodes !== flow.nodes || edges !== flow.edges) flowStore.setState({ nodes, edges });
});
import.meta.hot?.dispose(unsubscribe);

export function onNodesChange(changes: NodeChange<CardNode>[]): void {
  const nodes = applyNodeChanges(changes, flowStore.getState().nodes);
  flowStore.setState({ nodes });
  // Fold positions back into the cards only when the drag settles: React Flow
  // fires a position change per pointermove with dragging: true and a final one
  // with dragging: false on release (keyboard and programmatic moves carry no
  // flag, so they commit at once). Committing per frame gave `cards` a new
  // identity every pointermove, which re-ran everything derived from it — the
  // roster's four passes, the participant edges' pair sweep, the timeline — on
  // every frame of a drag. During the drag only the node moves; its
  // `data.card.position` lags, harmlessly: nothing renders it (Tidy reads React
  // Flow's own positions). Select/dimension churn stays here. (Deletion is an
  // M2 feature; see deleteKeyCode.)
  if (changes.some((c) => c.type === 'position' && !c.dragging)) {
    boardStore.getState().arrangeCards(new Map(nodes.map((n) => [n.id, n.position])));
  }
}

export function onEdgesChange(changes: EdgeChange<StringEdge>[]): void {
  flowStore.setState({ edges: applyEdgeChanges(changes, flowStore.getState().edges) });
}

export function onConnect(conn: FlowConnection): void {
  if (conn.source && conn.target) boardStore.getState().addConnection(conn.source, conn.target);
}
