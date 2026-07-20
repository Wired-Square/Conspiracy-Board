import type { Card, Connection, EmailAddress, EmailMeta } from '../types/board';
import { addressDomain, normaliseAddress, normaliseDomain } from './email/addresses';
import { normaliseNumber } from './phone';
import { otherEnd } from './connections';
import { isEntityKind, CARD_KINDS } from './kinds';
import { communicationParties } from './comms';
import { newestFirst } from './dates';

// Who is in what. Emails belong to people by address and to organisations by
// domain, and an email belongs to both at once — so this is a graph, not a tree,
// and none of it is stored. The address is the join, exactly as the Message-ID
// joins a dragged Mail message to the card waiting for it.
//
// It lives here rather than in lib/email/ because it answers questions about
// *cards* and spans three kinds; lib/clusters.ts is the precedent — rules
// consumed in several shapes (the canvas, the editor, the import modal) live in
// one place rather than being re-derived by each.
//
// Mind what the derivations are worth: they are not all the same claim. That an
// email came from jane@acme.com is a primary document. That *Jane works for
// Acme* because her address ends in acme.com is an inference — a reasoned read
// of the record, not a finding. Nothing here may be promoted to the other: the
// derived layer suggests, and only the user asserts, by drawing a Connection
// that carries its own grade.

/**
 * Everyone on a message: from, to and cc, and nothing else. Stated once so the
 * matcher and the import offer cannot come to disagree about which fields count
 * — adding reply-to would otherwise have to be remembered in both.
 */
export function participantAddresses(email: EmailMeta): EmailAddress[] {
  return [email.from, ...email.to, ...email.cc].filter(
    (a): a is EmailAddress => !!a?.address,
  );
}

/** Parties folded to the identity they match on, deduped, blanks dropped. `fold` is
 *  the identity function — `normaliseAddress` for email, `normaliseNumber` for a text
 *  or call — so the one pass serves both. */
function normalised(
  parties: readonly (EmailAddress | null)[],
  fold: (s: string) => string = normaliseAddress,
): string[] {
  return unique(
    parties.filter((a): a is EmailAddress => !!a?.address).map((a) => fold(a.address)).filter(Boolean),
  );
}

/** Every address on a message, normalised and deduped. */
export function emailParticipants(email: EmailMeta): string[] {
  return normalised(participantAddresses(email));
}


/**
 * Who sent it, and who got it. Matching does not care — an address on a message
 * is an address on a message — but a person reading their own mail cares about
 * almost nothing else, so the direction is kept rather than flattened away.
 *
 * Cc counts as received: the difference between To and Cc is etiquette, not
 * whether the message reached them.
 */
function sentAddresses(email: EmailMeta): string[] {
  return normalised([email.from]);
}

function receivedAddresses(email: EmailMeta): string[] {
  return normalised([...email.to, ...email.cc]);
}

export type Roster = {
  /** Normalised address → the person card claiming it. */
  personByAddress: Map<string, string>;
  /** Normalised address → the organisation claiming it in its own right. */
  orgByAddress: Map<string, string>;
  /** Normalised domain → the organisation card claiming it. */
  orgByDomain: Map<string, string>;
  /** Normalised number → the person card claiming it. A text or call matches by this,
   *  the way an email matches by address. */
  personByNumber: Map<string, string>;
  /** Normalised number → the organisation card claiming it (a body's switchboard). */
  orgByNumber: Map<string, string>;
  /**
   * Communication card id (email, text or call) → the person cards on it. All three
   * feed it — email matched by address, a text or call by number — so participantsOf
   * and the rest treat them the same without ever knowing the kind.
   */
  peopleByComm: Map<string, string[]>;
  /** Communication card id → the organisation cards on it (an email's by domain). */
  orgsByComm: Map<string, string[]>;
  /**
   * Person or organisation card id → the communications it sent (it is the From).
   *
   * Direction is kept because it is only knowable here: by the time a caller has a
   * communication's id, from/to/cc have been flattened into one list of participants.
   * There is no third map for "either way" — that is these two, and participantsOf
   * unions them, which it was already doing to five others.
   */
  commsSentBy: Map<string, string[]>;
  /** Person or organisation card id → the communications it received (To or Cc). */
  commsReceivedBy: Map<string, string[]>;
  /** Person card id → organisations implied by their address domains. */
  orgsByPerson: Map<string, string[]>;
  /** Organisation card id → its people. The reverse of orgsByPerson. */
  peopleByOrg: Map<string, string[]>;
};

/**
 * Build the whole graph in one pass over the cards.
 *
 * Gates on `card.kind` and never on a payload merely being present: switching a
 * card's kind deliberately leaves the old payload behind, so an evidence card
 * may still carry `person` from a mis-click and must not be filed as a person.
 * `kind` is the only authority (see Card in types/board.ts).
 *
 * Where two entities claim one address, the first in card order wins — decided
 * rather than left to chance. Surfacing that conflict to the user is worth doing
 * and is not this function's job.
 */
export function buildRoster(cards: Card[]): Roster {
  const roster: Roster = {
    personByAddress: new Map(),
    orgByAddress: new Map(),
    orgByDomain: new Map(),
    personByNumber: new Map(),
    orgByNumber: new Map(),
    peopleByComm: new Map(),
    orgsByComm: new Map(),
    commsSentBy: new Map(),
    commsReceivedBy: new Map(),
    orgsByPerson: new Map(),
    peopleByOrg: new Map(),
  };

  // Entities first: the emails below are matched against them.
  for (const card of cards) {
    if (card.kind === 'person' && card.person) {
      for (const raw of card.person.addresses) {
        claim(roster.personByAddress, normaliseAddress(raw), card.id);
      }
      for (const raw of card.person.numbers ?? []) {
        claim(roster.personByNumber, normaliseNumber(raw), card.id);
      }
    } else if (card.kind === 'organisation' && card.organisation) {
      for (const raw of card.organisation.addresses) {
        claim(roster.orgByAddress, normaliseAddress(raw), card.id);
      }
      for (const raw of card.organisation.domains) {
        claim(roster.orgByDomain, normaliseDomain(raw), card.id);
      }
      for (const raw of card.organisation.numbers ?? []) {
        claim(roster.orgByNumber, normaliseNumber(raw), card.id);
      }
    }
  }

  // Emails, matched to actors by address, and organisations by domain too.
  for (const card of cards) {
    if (card.kind !== 'email' || !card.email) continue;
    const addresses = emailParticipants(card.email);
    linkParticipants(
      roster,
      card.id,
      peopleAt(roster, addresses),
      orgsAt(roster, addresses),
      // Kept apart by direction: an organisation that owns the sender's domain *did*
      // send this, by the same inference that puts it on the message at all.
      entitiesAt(roster, sentAddresses(card.email)),
      entitiesAt(roster, receivedAddresses(card.email)),
    );
  }

  // Texts and calls, matched to actors by number the way email is by address — the
  // one projection (communicationParties) and the one tail (linkParticipants) mean
  // participantsOf, allSuggestedLinks and relationsOf treat a message exactly like a mail.
  for (const card of cards) {
    const parties = communicationParties(card);
    if (!parties || parties.matchBy !== 'number') continue;
    const sent = normalised([parties.from], normaliseNumber);
    const received = normalised(parties.to, normaliseNumber);
    const all = unique([...sent, ...received]);
    linkParticipants(
      roster,
      card.id,
      unique(lookup(roster.personByNumber, all)),
      unique(lookup(roster.orgByNumber, all)),
      numberEntitiesAt(roster, sent),
      numberEntitiesAt(roster, received),
    );
  }

  // Person → organisation, for free: an address at acme.com is Acme's. This is
  // the inference above — real enough to draw, never strong enough to assert —
  // folded in alongside the shared-email links already gathered.
  for (const card of cards) {
    if (card.kind !== 'person' || !card.person) continue;

    // domainsOf normalises on the way through addressDomain, so the addresses
    // go in as they are stored.
    const orgs = unique(lookup(roster.orgByDomain, domainsOf(card.person.addresses)));
    for (const orgId of orgs) {
      pushUnique(roster.orgsByPerson, card.id, orgId);
      pushUnique(roster.peopleByOrg, orgId, card.id);
    }
  }

  return roster;
}

/**
 * Wire one communication's participants into the graph: its people and organisations
 * (keyed by the card), the person×organisation cross-product they imply, and its mail
 * kept apart by direction. Shared by the email and text/call passes — they differ only
 * in how they resolve the four id-lists (by address vs by number), said once here so a
 * change to the participant graph can't drift between the two that look nothing alike.
 */
function linkParticipants(
  roster: Roster,
  cardId: string,
  people: string[],
  orgs: string[],
  sentIds: string[],
  receivedIds: string[],
): void {
  if (people.length) roster.peopleByComm.set(cardId, people);
  if (orgs.length) roster.orgsByComm.set(cardId, orgs);
  // A person and an organisation on the same message are linked by it: the invoice
  // ties whoever it was sent to to the organisation that sent it.
  for (const pid of people) {
    for (const oid of orgs) {
      pushUnique(roster.orgsByPerson, pid, oid);
      pushUnique(roster.peopleByOrg, oid, pid);
    }
  }
  for (const id of sentIds) push(roster.commsSentBy, id, cardId);
  for (const id of receivedIds) push(roster.commsReceivedBy, id, cardId);
}

/**
 * Every card related to this one by participation, whichever kind it is. Only
 * the maps that apply to a given id hold anything for it, so this needs no
 * knowledge of kinds.
 */
export function participantsOf(roster: Roster, cardId: string): string[] {
  return unique([
    ...(roster.peopleByComm.get(cardId) ?? []),
    ...(roster.orgsByComm.get(cardId) ?? []),
    // Its mail, whichever way it went — the two directions are the whole of it,
    // and unique() below is already what makes someone cc'd on their own message
    // appear once.
    ...(roster.commsSentBy.get(cardId) ?? []),
    ...(roster.commsReceivedBy.get(cardId) ?? []),
    ...(roster.orgsByPerson.get(cardId) ?? []),
    ...(roster.peopleByOrg.get(cardId) ?? []),
  ]);
}

/** How an address reached the entity it resolved to. `org-domain` is the
 *  inference — an address at acme.com is Acme's — so a caller can render it as
 *  softer than a person or an organisation that holds the address outright. */
export type AddressMatch = { id: string; via: 'person' | 'org-address' | 'org-domain' | 'org-number' };

/**
 * Both entities an address resolves to: the person who holds it, if any, and the
 * organisation it belongs to — by an address the organisation holds outright,
 * else by owning its domain. Either or both may be absent, and an address can be
 * a person's and an organisation's at once (alex@acme is Alex, and Acme's), which
 * is why the editor shows both rather than picking a winner.
 */
export function entitiesForAddress(
  roster: Roster,
  address: string,
): { personId?: string; org?: AddressMatch } {
  const norm = normaliseAddress(address);
  const personId = roster.personByAddress.get(norm);
  const orgAddress = roster.orgByAddress.get(norm);
  if (orgAddress) return { personId, org: { id: orgAddress, via: 'org-address' } };
  const domain = addressDomain(norm);
  const orgDomain = domain ? roster.orgByDomain.get(domain) : undefined;
  return { personId, org: orgDomain ? { id: orgDomain, via: 'org-domain' } : undefined };
}

/**
 * The single best entity an address resolves to, or null: the person if one
 * holds it, otherwise the organisation. One match is all it takes for the
 * address to be accounted for — see unaccountedAddresses.
 */
export function entityForAddress(roster: Roster, address: string): AddressMatch | null {
  const { personId, org } = entitiesForAddress(roster, address);
  if (personId) return { id: personId, via: 'person' };
  return org ?? null;
}

/**
 * The number counterpart of `entitiesForAddress`: the person and/or organisation a
 * phone number resolves to. There is no domain analogue for a number, so an
 * organisation only ever holds one outright (`org-number`) — no inference tier.
 */
export function entitiesForNumber(
  roster: Roster,
  number: string,
): { personId?: string; org?: AddressMatch } {
  const n = normaliseNumber(number);
  const personId = roster.personByNumber.get(n);
  const orgId = roster.orgByNumber.get(n);
  return { personId, org: orgId ? { id: orgId, via: 'org-number' } : undefined };
}

/** Ids to cards, dropping any with no card behind them rather than a hole. */
function cardsFor(ids: readonly string[], byId: ReadonlyMap<string, Card>): Card[] {
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Everything derived about one card, in the shape the editor reads it: the
 * actors it shares addresses with, and its mail, kept apart by direction.
 *
 * One function because the editor always wants all three at once, and asking
 * separately would index every card on the board once per list — three times a
 * frame while a card is being dragged with the panel open.
 *
 * Mail is split out from the actors because a message has a direction and an
 * actor does not. Both are empty for an email: a message has no mail of its own.
 */
export function relationsOf(
  roster: Roster,
  cardId: string,
  cards: readonly Card[],
): { actors: Card[]; sent: Card[]; received: Card[] } {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return {
    // Order comes from KIND_META, so a third actor kind lands in the right place
    // by declaring its register rather than by anyone remembering this list.
    actors: cardsFor(participantsOf(roster, cardId), byId)
      .filter((c) => isEntityKind(c.kind))
      .sort(
        (a, b) =>
          CARD_KINDS.indexOf(a.kind) - CARD_KINDS.indexOf(b.kind) ||
          a.title.localeCompare(b.title),
      ),
    sent: cardsFor(roster.commsSentBy.get(cardId) ?? [], byId).sort(newestFirst),
    received: cardsFor(roster.commsReceivedBy.get(cardId) ?? [], byId).sort(newestFirst),
  };
}

/**
 * Every pair of visible cards the canvas should string together as a
 * suggestion: participants of each other, both visible, and not already joined
 * by hand. Pairs come back unordered (lower id first) and deduped, exactly as
 * the canvas draws them, from one pass over the links.
 *
 * `links` is structural rather than Connection[], so a stored connection and a
 * rendered edge both satisfy it.
 *
 * A pair already strung gets no suggestion. It has been taken — and since the
 * yarn path is worked out from the two cards' positions, a second strand would
 * land on the very same curve as the string already there, which reads as a
 * rendering fault rather than as a second claim. And a hidden cluster hides
 * its cards, so a link into one would tie to nothing.
 */
export function allSuggestedLinks(
  roster: Roster,
  visibleIds: ReadonlySet<string>,
  links: readonly { source: string; target: string }[],
): { source: string; target: string }[] {
  // Who is already strung to whom, both ways — the same multimap idiom as the
  // roster's own adjacency maps.
  const strung = new Map<string, string[]>();
  for (const l of links) {
    pushUnique(strung, l.source, l.target);
    pushUnique(strung, l.target, l.source);
  }

  const seen = new Set<string>();
  const pairs: { source: string; target: string }[] = [];
  for (const id of visibleIds) {
    const tied = strung.get(id);
    for (const other of participantsOf(roster, id)) {
      if (!visibleIds.has(other) || tied?.includes(other)) continue;
      const [a, b] = id < other ? [id, other] : [other, id];
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ source: a, target: b });
    }
  }
  return pairs;
}

// The import offer, below. `drafts` is structural rather than EmailDraft[], so
// both a parsed draft and a Card already on the board satisfy it.

export type UnseenParticipant = {
  /** Normalised — the identity, and the key the caller's choice is filed under. */
  address: string;
  /** The best display name seen across the batch, for the row's label. */
  name?: string;
  domain: string | null;
  /** Messages in the batch it appears in. The offer ranks by this. */
  count: number;
};

export type UnseenDomain = {
  domain: string;
  /** Messages in the batch it appears in. */
  count: number;
  /** Distinct addresses seen at it — a rough sense of how big it is. */
  addressCount: number;
};

/**
 * Addresses in a batch that no person or organisation claims yet, commonest
 * first. Offered on import so the user can make cards for the handful they came
 * for, rather than the app carpeting the board with every newsletter it saw.
 */
export function unseenParticipants(
  drafts: readonly { email: EmailMeta }[],
  roster: Roster,
): UnseenParticipant[] {
  const seen = new Map<string, UnseenParticipant>();

  for (const draft of drafts) {
    const named = new Map<string, string | undefined>();
    for (const a of participantAddresses(draft.email)) {
      const address = normaliseAddress(a.address);
      if (!address || named.has(address)) continue; // once per message
      named.set(address, a.name?.trim() || undefined);
    }

    for (const [address, name] of named) {
      if (roster.personByAddress.has(address) || roster.orgByAddress.has(address)) continue;

      const found = seen.get(address);
      if (found) {
        found.count++;
        found.name ??= name;
      } else {
        seen.set(address, { address, name, domain: addressDomain(address), count: 1 });
      }
    }
  }

  return [...seen.values()].sort(byCountThen((p) => p.address));
}

/**
 * Domains in a batch that no organisation claims yet, commonest first.
 *
 * Freemail is left out: an "Organisation: gmail.com" card is noise, and worse,
 * it is wrong — a mail provider is not a body anyone is investigating. The list
 * only suppresses the *offer*; a user who deliberately makes a card for one of
 * these domains still gets their matches.
 */
export function unseenDomains(
  drafts: readonly { email: EmailMeta }[],
  roster: Roster,
): UnseenDomain[] {
  // addressCount is spoken once, at the end — the accumulator carries the set it
  // is counted from rather than a running total to keep in step.
  const seen = new Map<string, { domain: string; count: number; addresses: Set<string> }>();

  for (const draft of drafts) {
    // emailParticipants already deduped, so an array per domain is enough here.
    const perMessage = new Map<string, string[]>();
    for (const address of emailParticipants(draft.email)) {
      const domain = addressDomain(address);
      if (!domain || roster.orgByDomain.has(domain) || FREEMAIL_DOMAINS.has(domain)) continue;
      push(perMessage, domain, address);
    }

    for (const [domain, addresses] of perMessage) {
      const found = seen.get(domain);
      if (found) {
        found.count++;
        addresses.forEach((a) => found.addresses.add(a));
      } else {
        seen.set(domain, { domain, count: 1, addresses: new Set(addresses) });
      }
    }
  }

  return [...seen.values()]
    .map(({ domain, count, addresses }) => ({ domain, count, addressCount: addresses.size }))
    .sort(byCountThen((d) => d.domain));
}

// Is this piece of paper accounted for? — the Record view's whole question.

/**
 * The addresses on an email that link to no one — neither a person nor an
 * organisation, by an address it holds or by its domain. One link is enough: an
 * address whose domain an organisation owns is accounted for by that
 * organisation, even before anyone names the person behind it.
 *
 * Deliberately a softer bar than the import offer's `unseenParticipants`, which
 * still offers to make a person for a role address (who is behind legal@?). The
 * two answer different questions — "is this row loose?" and "is there still a
 * card worth making?" — so they are allowed to differ.
 */
export function unaccountedAddresses(card: Card, roster: Roster): string[] {
  if (card.kind !== 'email' || !card.email) return [];
  return emailParticipants(card.email).filter((a) => !entityForAddress(roster, a));
}

/** The ids of every actor on the board. Built once and asked many times. */
export function actorIds(cards: readonly Card[]): Set<string> {
  return new Set(cards.filter((c) => isEntityKind(c.kind)).map((c) => c.id));
}

/**
 * Whether a document names anybody: string from it to a person or organisation.
 *
 * A document has no addresses, so nothing can be derived about it — the only
 * thing that ties a warrant to the person it names is a link somebody drew. An
 * unlinked document is a piece of paper in a drawer.
 *
 * Takes the actors rather than finding them: the answer is the same for every
 * document on the board, and the caller is asking once per row.
 */
export function isLinkedDocument(
  cardId: string,
  connections: readonly Connection[],
  actors: ReadonlySet<string>,
): boolean {
  return connections.some((c) => {
    const other = otherEnd(c, cardId);
    return other !== null && actors.has(other);
  });
}

/**
 * Mail providers, not organisations. Kept deliberately short: it only has to
 * cover what turns up often enough to be noise, and a domain wrongly absent
 * costs one unticked row, where a domain wrongly present hides a real body.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.com.au',
  'msn.com',
  'yahoo.com',
  'yahoo.com.au',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  // Australian ISPs, which hand out personal mail the same way.
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'iinet.net.au',
  'tpg.com.au',
  'internode.on.net',
]);

// Small shared bits.

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** First claim wins, so a contested address resolves the same way every time. */
function claim(map: Map<string, string>, key: string, cardId: string): void {
  if (key && !map.has(key)) map.set(key, cardId);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const found = map.get(key);
  if (found) found.push(value);
  else map.set(key, [value]);
}

/** push, but only if the value isn't already under the key — for the person↔
 *  organisation maps, which two derivations feed: the shared domain and a shared
 *  email. Either alone is enough; both must not double the link. */
function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  const found = map.get(key);
  if (!found) map.set(key, [value]);
  else if (!found.includes(value)) found.push(value);
}

function lookup(map: Map<string, string>, keys: (string | null)[]): string[] {
  return keys.map((k) => (k ? map.get(k) : undefined)).filter((id): id is string => !!id);
}

// How an address reaches a card. Said once, because a fourth route would
// otherwise have to be remembered in two places that look nothing alike.

/** The people claiming any of these addresses. */
function peopleAt(roster: Roster, addresses: string[]): string[] {
  return unique(lookup(roster.personByAddress, addresses));
}

/**
 * The organisations. Reached two ways: holding the address itself
 * (legal@acme.com), or owning the domain the address sits at.
 */
function orgsAt(roster: Roster, addresses: string[]): string[] {
  return unique([
    ...lookup(roster.orgByAddress, addresses),
    ...lookup(roster.orgByDomain, domainsOf(addresses)),
  ]);
}

/** Everyone, of either kind. */
function entitiesAt(roster: Roster, addresses: string[]): string[] {
  return unique([...peopleAt(roster, addresses), ...orgsAt(roster, addresses)]);
}

/** Everyone reached by a number — a person or an organisation that holds it. The
 *  number counterpart of `entitiesAt`, for the message/call pass. */
function numberEntitiesAt(roster: Roster, numbers: string[]): string[] {
  return unique([...lookup(roster.personByNumber, numbers), ...lookup(roster.orgByNumber, numbers)]);
}

function domainsOf(addresses: string[]): string[] {
  return unique(addresses.map(addressDomain).filter((d): d is string => !!d));
}

/** Commonest first, then by a stable key — so equal counts do not shuffle. */
function byCountThen<T extends { count: number }>(key: (item: T) => string) {
  return (a: T, b: T) => b.count - a.count || key(a).localeCompare(key(b));
}
