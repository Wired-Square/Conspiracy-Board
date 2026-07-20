import type { Card, Vec2 } from '../types/board';
import { isBoardKind } from './kinds';

// The card face is 210px wide (see .evidence-card in index.css); a full card
// plus a gutter clears any existing card by construction rather than by luck.
// CARD_H is a fallback only — real height is content-dependent and comes from
// React Flow's measured node; both are exported for callers that need a size
// before a node has been measured (see Toolbar's Tidy).
export const CARD_W = 210;
export const CARD_H = 140;
const GUTTER = 110;
const STEP_X = 260;
const STEP_Y = 220;
const MAX_COLS = 6;

/**
 * How much an actor's card grows with its connections: 1 at no strings, rising
 * with the square root of the degree (so the tenth string matters less than
 * the first), capped so the most-connected person on an mbox board stays a
 * card rather than a poster. Degree is a count of what the board draws —
 * hand-strung connections and derived participant links alike (see
 * useHighlightConnections). Rounded only to keep the inline style value tidy.
 */
export function actorScale(degree: number): number {
  return Math.round(Math.min(1.5, 1 + 0.08 * Math.sqrt(degree)) * 100) / 100;
}

/**
 * Grid positions for `count` new cards, placed clear of the existing board.
 *
 * "Clear of" means clear of what is *drawn*. A record card still carries a
 * position it will never be placed at, and counting those would push the next
 * person hundreds of pixels into empty space for every mail import — the board
 * would drift east forever, one mbox at a time.
 */
export function gridPositions(count: number, existing: Card[]): Vec2[] {
  const drawn = existing.filter((c) => isBoardKind(c.kind));
  const origin: Vec2 = drawn.length
    ? {
        x: Math.max(...drawn.map((c) => c.position.x)) + CARD_W + GUTTER,
        y: Math.min(...drawn.map((c) => c.position.y)),
      }
    : { x: 80, y: 80 };

  const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(count))));

  return Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % cols) * STEP_X,
    y: origin.y + Math.floor(i / cols) * STEP_Y,
  }));
}
