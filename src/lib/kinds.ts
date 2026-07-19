import type { Card, CardKind } from '../types/board';
import { emptyEmailMeta } from './email/meta';
import { emptyCallMeta, emptyMessageMeta } from './comms';
import { emptyOrgMeta, emptyPersonMeta } from './entities';
import type { View } from '../types/view';
import type { MediaIconType } from './mediaIcon';

// Everything the app needs to know about a kind, in one table.
//
// The table is the point. `Record<CardKind, …>` means a new kind cannot be added
// to the model and forgotten here, and everything below is a lookup rather than
// its own list of kinds to keep in step — which is what the kind select used to
// be, hardcoded and cast, where a missing option was invisible to the compiler.

/**
 * Which of the three registers a kind belongs to. This is the organising idea of
 * the model and it decides what a card can carry, so it is a field rather than
 * something each predicate re-derives:
 *
 * - `actor` — a legal entity. Holds addresses, is matched to email, is never
 *   graded (a person is not a claim) and is never on the timeline (nor a moment).
 * - `record` — it exists; you are holding it. Never graded for the same reason a
 *   ruler is not accurate: it is the thing others are measured against. A dispute
 *   about a document's authenticity is a claim *about* it — an evidence card,
 *   connected to it, graded refuted.
 * - `argument` — a claim, so it might be wrong, so it is graded.
 */
export type Register = 'actor' | 'record' | 'argument';

type KindMeta = {
  label: string;
  register: Register;
  /** Shown under the kind select. Carries the event-vs-evidence rule. */
  hint: string;
  /** Prefix for the card's kind line. Absent means the card says nothing. */
  icon?: string;
  /**
   * The list/timeline glyph (an SVG, see ui/MediaIcon), for the surfaces that draw
   * one from a card's kind — the record and the timeline. `null` where the kind
   * shows none there (the actors don't appear; an event has its own milestone
   * marker; evidence carries none). Required, not optional, so a new kind can't be
   * added without deciding. Distinct from `icon`, the emoji still used on board
   * cards and in the editors.
   */
  mediaIcon: MediaIconType | null;
  /** The payload this kind needs to be editable. Absent means it needs none. */
  emptyPayload?: () => Partial<Card>;
};

export const KIND_META: Record<CardKind, KindMeta> = {
  person: {
    label: 'Person',
    register: 'actor',
    icon: '👤',
    mediaIcon: null,
    hint: 'Someone. Their emails find them by address.',
    emptyPayload: () => ({ person: emptyPersonMeta() }),
  },
  organisation: {
    label: 'Organisation',
    register: 'actor',
    icon: '🏛',
    mediaIcon: null,
    hint: 'A company or body. Its emails find it by domain.',
    emptyPayload: () => ({ organisation: emptyOrgMeta() }),
  },
  document: {
    label: 'Document',
    register: 'record',
    icon: '📄',
    mediaIcon: 'document',
    hint: 'Part of the record — a warrant, a filing, an invoice. It exists.',
    emptyPayload: () => ({ document: {} }),
  },
  email: {
    label: 'Email',
    register: 'record',
    icon: '✉',
    mediaIcon: 'email',
    hint: 'A document that arrived by mail.',
    emptyPayload: () => ({ email: emptyEmailMeta() }),
  },
  message: {
    label: 'Message',
    register: 'record',
    icon: '💬',
    mediaIcon: 'message',
    hint: 'A text message. Its from/to find people by number; a screenshot justifies it.',
    emptyPayload: () => ({ message: emptyMessageMeta() }),
  },
  call: {
    label: 'Call',
    register: 'record',
    icon: '📞',
    mediaIcon: 'call',
    hint: 'A phone call. Its from/to find people by number; a screenshot justifies it.',
    emptyPayload: () => ({ call: emptyCallMeta() }),
  },
  // No icon: the argument is what a board is mostly made of, and a badge on the
  // common case would leave the badge nothing to mean.
  event: {
    label: 'Event',
    register: 'argument',
    mediaIcon: null,
    hint: 'Something happened, at a time. Graded: did it happen?',
  },
  evidence: {
    label: 'Evidence',
    register: 'argument',
    mediaIcon: null,
    hint: 'Something is so, with no moment. Graded: is it so?',
  },
};

/** Display order for the kind select: the actors, the record, the argument. */
export const CARD_KINDS = Object.keys(KIND_META) as CardKind[];

/** Existing cards of a kind, sorted by title — a list in board order is a lucky dip. */
export function entitiesOfKind(cards: Card[], kind: CardKind): Card[] {
  return cards.filter((c) => c.kind === kind).sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * What a card is when nobody has said — a plain note. It is also what every card
 * written before kinds existed silently was, which is why the schema defaults
 * `kind` to it on the way in (`src/data/schema.ts`, the one other place this
 * literal is allowed to live: it is the migration boundary).
 */
export const DEFAULT_KIND: CardKind = 'evidence';

/**
 * A legal entity. People and organisations are one concept wearing two hats:
 * both hold addresses, both are matched to email, neither is graded. They stay
 * separate kinds only because their join keys differ — address vs domain.
 */
export function isEntityKind(kind: CardKind): boolean {
  return KIND_META[kind].register === 'actor';
}

/** Whether a card is a claim, and so might be wrong. */
export function isGradedKind(kind: CardKind): boolean {
  return KIND_META[kind].register === 'argument';
}

/**
 * Whether a card came from a file the user imported: an email with its `.eml`
 * (or a message dragged from Mail, whose `.eml` follows), or a document with a
 * file. Its kind is not a guess to be corrected — it is what the file is.
 */
export function isImportedCard(card: Card): boolean {
  return !!(card.email?.emlFile || card.email?.source || card.document?.file);
}

/**
 * Whether a card's kind may still be changed. Locked once the card is a concrete
 * thing: an actor is a legal entity, and an import is whatever its file is, so
 * neither is a mis-classification to fix later. What stays changeable is the
 * argument (evidence ↔ event) and a hand-made record shell not yet filled — the
 * plain "Card" you reach for before deciding what it is.
 */
export function canChangeKind(card: Card): boolean {
  return !isEntityKind(card.kind) && !isImportedCard(card);
}

/**
 * Whether a card can appear on the timeline at all. Only actors are excluded,
 * and by register rather than by having no date: they would otherwise pile into
 * the undated column and bury the cards that are genuinely undated there.
 * Everything else stays governed by `occurredAt` as it always was.
 */
export function isTimelineKind(kind: CardKind): boolean {
  return KIND_META[kind].register !== 'actor';
}

/**
 * The record: the paper itself. It is what a board argues *from*, not what it
 * argues, so it is not drawn on the board — it lives in the Record view, and on
 * the timeline when it is dated.
 *
 * A mail import is what makes this necessary rather than tidy. Two hundred
 * messages are two hundred cards and a violet strand from every person to each
 * of theirs; the argument disappears under the post.
 */
export function isRecordKind(kind: CardKind): boolean {
  return KIND_META[kind].register === 'record';
}

/** Whether a card is drawn on the board. Everything the record is not. */
export function isBoardKind(kind: CardKind): boolean {
  return !isRecordKind(kind);
}

/**
 * Where a card of this kind lives — the one answer to that question.
 *
 * Every surface reads it: the canvas draws what belongs to it, the Record view
 * lists what belongs to it, and making or selecting a card takes you to
 * whichever place it went. Without this in one piece, each of those has to
 * remember the rule separately, and the one that forgets makes a card that
 * appears nowhere at all.
 */
export function viewFor(kind: CardKind): View {
  return isRecordKind(kind) ? 'record' : 'board';
}

/** The payload a brand-new card of this kind needs, for the + Add menu. */
export function emptyPayloadFor(kind: CardKind): Partial<Card> {
  return KIND_META[kind].emptyPayload?.() ?? {};
}

/**
 * What it takes to make an existing card a `kind`: the payload if it hasn't got
 * one, and nothing at all if it has.
 *
 * Only ever adds. Switching email → person → email must be a mis-click rather
 * than the silent loss of parsed headers, so a payload the card already carries
 * is left exactly where it is — including one for a kind it no longer is, which
 * simply goes unread (see Card in types/board.ts).
 */
export function payloadPatchFor(card: Card, kind: CardKind): Partial<Card> {
  return Object.fromEntries(
    Object.entries(emptyPayloadFor(kind)).filter(
      ([key]) => card[key as keyof Card] === undefined,
    ),
  );
}
