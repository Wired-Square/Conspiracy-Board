import type { Card, CallMeta, EmailAddress, MessageMeta } from '../types/board';

// The empty communications payloads, in one place — what a fresh Message or Call card
// carries before anything is typed into it. Mirrors emptyEmailMeta / emptyPersonMeta:
// the `+ Add` menu and the editor both reach for these so a new card of the kind is
// editable from the first render (see KIND_META.emptyPayload and CommsFields).

export const emptyMessageMeta = (): MessageMeta => ({ from: null, to: [] });

export const emptyCallMeta = (): CallMeta => ({ from: null, to: [] });

/**
 * The parties of a communication card — email, text or call — as one shape, so the
 * surfaces that ask "who was this between" (the record's whoLine, the roster's number
 * match, the search matcher) ask once rather than each re-branching on kind. `to` folds
 * an email's cc in — a cc'd person still received it — and `matchBy` says which identity
 * the addresses carry: an email matches people by address, a text or call by number.
 * Null for any other kind.
 */
export function communicationParties(
  card: Card,
): { from: EmailAddress | null; to: EmailAddress[]; matchBy: 'address' | 'number' } | null {
  if (card.kind === 'email' && card.email) {
    return { from: card.email.from, to: [...card.email.to, ...card.email.cc], matchBy: 'address' };
  }
  if (card.kind === 'message' && card.message) {
    return { from: card.message.from, to: card.message.to, matchBy: 'number' };
  }
  if (card.kind === 'call' && card.call) {
    return { from: card.call.from, to: card.call.to, matchBy: 'number' };
  }
  return null;
}
