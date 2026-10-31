import type { Card, ConnectionKind, Grade } from './board';

/**
 * The card itself, plus the only things actually derived for the view.
 *
 * It carries `card` rather than a copy of its fields: a flattened copy has to be
 * widened here *and* in cardToNode for every field the model gains, which is
 * three files to change to show one thing — and a field nobody reads yet still
 * has to be listed twice. The board stays canonical (README rule 1); this is a
 * view of it, and the resolved cluster colours — the primary's accent and the
 * dots for the rest — are the only parts that are derivations.
 */
export type CardNodeData = {
  card: Card;
  clusterColor: string | null;
  extraClusterColors: string[];
  /**
   * How much an actor's face grows with its connections (see actorScale).
   * Written by the board's highlight pass — it is a function of the edges drawn,
   * which only the canvas knows — not by cardToNode. Absent means 1.
   */
  tieScale?: number;
};

export type CardNode = {
  id: string;
  x: number;
  y: number;
  data: CardNodeData;
  className?: string;
  selected?: boolean;
};

export type StringEdgeData = {
  label?: string;
  kind?: ConnectionKind;
  grade?: Grade;
  /**
   * 'participant' marks a link derived from the addresses (see lib/roster) —
   * the app's suggestion, not a Connection anyone drew. It is a variant rather
   * than a second edge *type* because it is the same string under the same
   * gravity; only the claim behind it differs, so only the stroke does.
   */
  variant?: 'participant';
};

export type StringEdge = {
  id: string;
  source: string;
  target: string;
  data: StringEdgeData;
  className?: string;
};
