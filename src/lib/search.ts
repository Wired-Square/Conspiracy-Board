import type { Card } from '../types/board';
import { participantAddresses } from './roster';
import { communicationParties } from './comms';
import { cardMediaEntries } from '../store/boardMigration';

// Free-text search over a card. One matcher, so every surface agrees on what a
// query matches: the board dims by it, the record filters by it, the timeline
// narrows by it. The fields are the ones a person types when looking for a card
// — a name, a subject, a phrase they remember writing, an address — not every
// field the card holds.

/**
 * The query as the matcher wants it: trimmed and lower-cased. Callers normalise
 * once per keystroke and pass the result down, rather than re-lowering it for
 * every card.
 */
export function normaliseQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether a card's text contains `q`, which must already be through
 * `normaliseQuery`. An empty query matches everything, so an idle search box
 * leaves every surface exactly as it was.
 *
 * Gated on `kind`, never on a payload merely being present: a card that was once
 * an email keeps its parsed headers after a kind change (see the note on
 * `Card.email`), and searching them would surface it as mail it no longer is.
 */
type Hit = (s?: string | null) => boolean;

/**
 * Whether `q` (via `hit`) matches one of a card's identifiers — an address, phone
 * number, domain, or a participant's name/address on a communication. The kinds and
 * fields `cardMatches` and `cardMatchesEntity` agree on, said once here so a new
 * identifier field or comms kind lands in one place rather than drifting between the
 * two matchers.
 */
function identifierHit(card: Card, hit: Hit): boolean {
  switch (card.kind) {
    case 'person':
      return !!card.person?.addresses.some(hit) || !!card.person?.numbers?.some(hit);
    case 'organisation': {
      const o = card.organisation;
      return !!o && (o.addresses.some(hit) || o.domains.some(hit) || !!o.numbers?.some(hit));
    }
    case 'email':
      return !!card.email && participantAddresses(card.email).some((a) => hit(a.name) || hit(a.address));
    case 'message':
    case 'call': {
      const parties = communicationParties(card);
      return !!parties && [parties.from, ...parties.to].some((a) => !!a && (hit(a.name) || hit(a.address)));
    }
    default:
      return false;
  }
}

export function cardMatches(card: Card, q: string): boolean {
  if (!q) return true;
  const hit: Hit = (s) => !!s && s.toLowerCase().includes(q);

  // Title and notes carry the most, and every kind has them — notes is also where
  // OCR'd screenshot text lands, so this covers picture cards too. Then the shared
  // identifiers, then the free text only the full matcher reads: a file's own words.
  if (hit(card.title) || hit(card.notes) || identifierHit(card, hit)) return true;

  switch (card.kind) {
    case 'email':
      return card.email?.attachments.some((att) => hit(att.name)) ?? false;
    case 'message':
      // Only a message carries a typed body; a call is justified by its screenshot.
      return hit(card.message?.body);
    case 'document':
      if (!card.document) return false;
      return hit(card.document.name) || hit(card.document.title) || hit(card.document.author);
    default:
      return false;
  }
}

/**
 * `cardMatches`, plus a hit when the query matched the full text of a file the card
 * carries — a PDF or Office body, the whole `.eml`, a screenshot's OCR — indexed in
 * the background (see the job queue and the shell's library.sqlite). `docHits` is the
 * set of media names the current query matched; the card is mapped to its files by
 * `cardMediaEntries`, the single enumeration of media-bearing fields, so the shell
 * hands back bare names and never learns the card's shape.
 *
 * An empty query still matches everything (via `cardMatches`); `docHits` is empty then
 * anyway, so the extra check is skipped.
 */
export function cardMatchesWithDocs(card: Card, q: string, docHits: Set<string>): boolean {
  if (cardMatches(card, q)) return true;
  if (docHits.size === 0) return false;
  return cardMediaEntries(card).some((e) => docHits.has(e.file));
}

/**
 * Whether a card's ENTITY IDENTIFIERS contain `q` — an actor's name, an email
 * address, a phone number, a domain. This is what the toolbar search matches: it
 * finds people and organisations by who they are, and communications by whom they
 * are with — not any free text on a card. Free text (notes, an argument's title,
 * a file's body) is the timeline's full-text search, not this one.
 *
 * Gated on `kind` like `cardMatches`. Argument and document cards carry no
 * identifier, so they never match here (they are found on the timeline).
 */
export function cardMatchesEntity(card: Card, q: string): boolean {
  if (!q) return true;
  const hit: Hit = (s) => !!s && s.toLowerCase().includes(q);
  // An actor's name is its title (see types/board.ts); everything else it matches on
  // is a shared identifier.
  if ((card.kind === 'person' || card.kind === 'organisation') && hit(card.title)) return true;
  return identifierHit(card, hit);
}
