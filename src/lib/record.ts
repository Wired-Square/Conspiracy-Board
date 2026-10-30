import type { Card, Connection } from '../types/board';
import { communicationParties } from './comms';
import { newestFirst } from './dates';
import { shortAddress } from './email/addresses';
import { isRecordKind } from './kinds';
import { actorIds, isLinkedDocument, unaccountedAddresses, type Roster } from './roster';

/** "Dutch Sable → Vivian Vane +2" — who a communication was between. Email, a text
 *  message and a phone call all have a from and a to (see communicationParties). */
export function whoLine(card: Card): string | null {
  const parties = communicationParties(card);
  if (!parties) return null;
  const to = parties.to.length
    ? shortAddress(parties.to[0]) + (parties.to.length > 1 ? ` +${parties.to.length - 1}` : '')
    : null;
  const from = shortAddress(parties.from);
  return to ? `${from} → ${to}` : from;
}

/**
 * What is still to do with this piece of paper, or null when it is done with.
 *
 * A record earns its place by being tied to somebody: an email when every
 * address on it belongs to a card, a document when string reaches an actor.
 * Until then it is a name nobody has looked up — and this is the list you work
 * off, which is what turns a mail import from a pile into a queue.
 */
export function whatsLoose(
  card: Card,
  roster: Roster,
  connections: readonly Connection[],
  actors: ReadonlySet<string>,
): string | null {
  switch (card.kind) {
    case 'document':
      return isLinkedDocument(card.id, connections, actors) ? null : 'names nobody';
    case 'email': {
      const n = unaccountedAddresses(card, roster).length;
      return n ? `${n} address${n === 1 ? '' : 'es'} unaccounted` : null;
    }
    default:
      // Only the record is asked, and the record is these two. A third kind must
      // answer for itself rather than defaulting to "nothing to do here", which
      // is the one wrong answer this list can give.
      return null;
  }
}

export type RecordRow = { card: Card; loose: string | null };

/**
 * The record's rows, newest first, and how many are loose — one pass, so the
 * count in the bar cannot disagree with the list under it. The actors are found
 * once rather than per row: the answer is the same for every document.
 */
export function recordRows(
  visible: Card[],
  allCards: Card[],
  roster: Roster,
  connections: readonly Connection[],
): { rows: RecordRow[]; looseCount: number } {
  const actors = actorIds(allCards);
  const rows = visible
    .filter((c) => isRecordKind(c.kind))
    .map((card) => ({ card, loose: whatsLoose(card, roster, connections, actors) }))
    .sort((a, b) => newestFirst(a.card, b.card));
  return { rows, looseCount: rows.filter((r) => r.loose).length };
}
