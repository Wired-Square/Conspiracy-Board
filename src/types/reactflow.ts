import type { Node, Edge } from '@xyflow/react';
import type { Card, ConnectionKind, Grade } from './board';

// React Flow requires node `data` to satisfy Record<string, unknown>, so these
// must be `type` aliases (object types), not interfaces. Only the top level is
// constrained, so a nested interface like Card is fine.

/**
 * The card itself, plus the one thing that is actually derived for the view.
 *
 * It carries `card` rather than a copy of its fields: a flattened copy has to be
 * widened here *and* in cardToNode for every field the model gains, which is
 * three files to change to show one thing — and a field nobody reads yet still
 * has to be listed twice. The board stays canonical (README rule 1); this is a
 * view of it, and `clusterColor` is the only part of it that is a derivation.
 */
export type CardNodeData = {
  card: Card;
  clusterColor: string | null;
};

/**
 * One node type for every kind. They are six faces of the same card — same
 * size, handles, accent, drag, selection — differing by a header line and a
 * colour, which EvidenceCardNode already handles by interpolating the kind into
 * its class. Six node types would widen this literal across the mappers, the
 * registry, the canvas handlers, the highlight hook and the store, for that.
 * Split when a kind needs a genuinely different shape, on the evidence.
 */
export type CardNode = Node<CardNodeData, 'evidenceCard'>;

export type StringEdgeData = {
  label?: string;
  kind?: ConnectionKind;
  grade?: Grade;
  /**
   * 'participant' marks a link derived from the addresses (see lib/roster) —
   * the app's suggestion, not a Connection anyone drew. It is a variant rather
   * than a second edge *type* because it is the same string under the same
   * gravity; only the claim behind it differs, so only the stroke does. A type
   * would widen the 'redString' literal across the mappers, the registry and
   * the canvas for one dash pattern.
   */
  variant?: 'participant';
};

export type StringEdge = Edge<StringEdgeData, 'redString'>;
