import type { Card, EmailMeta } from '../../types/board';

/** A blank set of email headers, for a card switched to kind 'email' by hand. */
export function emptyEmailMeta(): EmailMeta {
  return {
    from: null,
    to: [],
    cc: [],
    messageId: null,
    inReplyTo: null,
    attachments: [],
  };
}

/** Cards already on the board that carry a Message-ID, keyed by it. */
export function emailCardsByMessageId(cards: Card[]): Map<string, Card> {
  const out = new Map<string, Card>();
  for (const c of cards) {
    const id = c.email?.messageId;
    if (id) out.set(id, c);
  }
  return out;
}

/**
 * A card that names a message but doesn't contain it — what dragging out of
 * Apple Mail produces, since Mail hands a browser the subject and Message-ID but
 * never the body. Importing the same message as a .eml completes one of these
 * rather than being turned away as a duplicate.
 *
 * Keyed on recorded provenance, not on which fields happen to be empty: a real
 * message with no From and no Date header (drafts, some machine-generated mail)
 * would otherwise be mistaken for one of these, and re-importing it would
 * overwrite whatever the user had written on the card.
 */
export function isReferenceCard(card: Card): boolean {
  return (
    card.email?.source === 'mail-drag' &&
    !!card.email.messageId &&
    // Still waiting for its content — once an import has filled the headers in,
    // the same message arriving again really is just a duplicate.
    !card.email.from
  );
}

export type DraftMatch =
  | { kind: 'new' }
  | { kind: 'duplicate' }
  | { kind: 'completes'; card: Card };

/**
 * What an incoming draft means for the board. Shared so the import preview and
 * the commit can't disagree about what is about to happen.
 *
 * A draft with no Message-ID never matches: two distinct hand-pasted messages
 * would otherwise collide on `null` and only the first would survive.
 */
export function matchDraft(
  draft: { email?: { messageId: string | null } },
  existing: Map<string, Card>,
): DraftMatch {
  const id = draft.email?.messageId;
  if (!id) return { kind: 'new' };
  const card = existing.get(id);
  if (!card) return { kind: 'new' };
  return isReferenceCard(card) ? { kind: 'completes', card } : { kind: 'duplicate' };
}
