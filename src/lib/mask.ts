import type { Card, Connection } from '../types/board';
import { oncePerArray } from './cardIndex';

export const REDACTED = 'Redacted';

export type MaskView = { mask: boolean; showMasked: boolean; unmaskedId: string | null };

/** The one rule every surface reads: whether `card` shows redacted, or not at all. */
export function isMasked(card: Pick<Card, 'id' | 'confidential'>, view: MaskView): boolean {
  return !!card.confidential && view.mask && card.id !== view.unmaskedId;
}

const redactions = new WeakMap<Card, Card>();
const redactedCards = new WeakSet<Card>();

/** Whether `card` is a redacted stand-in, which no search or filter may match. */
export const isRedacted = (card: Card) => redactedCards.has(card);

/** What a masked card shows: kind, date and place, as the library MCP's `locked()` keeps them. */
export function redacted(card: Card): Card {
  let copy = redactions.get(card);
  if (!copy) {
    copy = {
      id: card.id,
      title: REDACTED,
      notes: '',
      imageUrl: null,
      imageFile: null,
      imageCrop: null,
      imageMeta: null,
      clusterIds: card.clusterIds,
      position: card.position,
      kind: card.kind,
      occurredAt: card.occurredAt,
      occurredAtPrecision: card.occurredAtPrecision,
      confidential: true,
    };
    redactions.set(card, copy);
    redactedCards.add(copy);
  }
  return copy;
}

/** The cards as the view shows them: masked ones redacted, or left out. `cards` itself when nothing is masked. */
export function seenCards(cards: Card[], view: MaskView): Card[] {
  let masked = false;
  const seen: Card[] = [];
  for (const card of cards) {
    if (!isMasked(card, view)) seen.push(card);
    else {
      masked = true;
      if (view.showMasked) seen.push(redacted(card));
    }
  }
  return masked ? seen : cards;
}

/** The connections the view draws: all of them, unless one end is a masked card left out. */
export function seenConnections(connections: Connection[], cards: Card[], view: MaskView): Connection[] {
  if (view.showMasked) return connections;
  const hidden = new Set(cards.filter((c) => isMasked(c, view)).map((c) => c.id));
  if (!hidden.size) return connections;
  return connections.filter((c) => !hidden.has(c.source) && !hidden.has(c.target));
}

/** The seen cards a picker may offer: a redacted card can't be told from another, and picking one writes to it. */
export const pickableCards = oncePerArray((cards) => cards.filter((c) => !isRedacted(c)));
