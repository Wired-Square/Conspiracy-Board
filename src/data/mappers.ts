import type { Board, Card, Cluster, Connection } from '../types/board';
import type { CardNode, StringEdge } from '../types/reactflow';
import { clusterColor, extraClusterColors, primaryClusterId } from '../lib/clusters';

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

export function connectionToEdge(c: Connection): StringEdge {
  return {
    id: c.id,
    source: c.source,
    target: c.target,
    type: 'redString',
    // `kind` used to be dropped here, so a connection's own fields never reached
    // the thing that draws it. Carrying them through is what lets a graded link
    // look different from an assumed one.
    data: { label: c.label, kind: c.kind, grade: c.grade },
  };
}

/** Build derived React Flow nodes/edges from the canonical board. */
export function boardToFlow(board: Board): { nodes: CardNode[]; edges: StringEdge[] } {
  return {
    nodes: board.cards.map((card) => cardToNode(card, board.clusters)),
    edges: board.connections.map(connectionToEdge),
  };
}
