import type { Card, OrgMeta, PersonMeta } from '../types/board';
import { emptyOrgMeta, emptyPersonMeta, withAddress, withDomain, withNumber } from './entities';
import type { UnseenDomain, UnseenParticipant } from './roster';

// What the import offer will actually do, worked out from the rows on screen and
// what the user ticked. It lives here rather than in the modal because it is the
// one part of that screen that decides anything — everything else there describes
// what is about to happen — and because deciding is the part worth testing.
// (Precedent: lib/clusters.ts and lib/roster.ts, for the same reason.)

/** The select's value for "make one", which is deliberately not a card id. */
export const NEW_CARD = 'new';

/**
 * What the user chose for one offered row. Only overrides are stored: a row that
 * was never touched has no entry and takes the default, so a fresh parse needs
 * nothing reset and a row nobody looked at cannot add anything.
 */
export type Choice = {
  on: boolean;
  /** NEW_CARD, or the id of an existing card to append this address/domain to. */
  target: string;
};

const UNTICKED: Choice = { on: false, target: NEW_CARD };

/**
 * Addresses and domains share one map of choices and cannot collide: an address
 * always carries an `@`, and a normalised domain never does.
 */
export function choiceFor(choices: ReadonlyMap<string, Choice>, key: string): Choice {
  return choices.get(key) ?? UNTICKED;
}

/**
 * A card the offer will mint. Narrower than the store's CardDraft on purpose —
 * these are the only fields the offer ever sets — and structurally assignable to
 * it, so lib does not have to reach into the store to say so.
 */
export type EntityDraft = {
  title: string;
  kind: 'person' | 'organisation';
  person?: PersonMeta;
  organisation?: OrgMeta;
};

/** Everything the offer (or an inline Link…) is pointing at one existing card. */
export type Aim = { addresses: string[]; domains: string[]; numbers?: string[] };

/**
 * A new person from an address. The card's title is its name (see types/board.ts),
 * and the address is the best name there is when nobody gave one. Shared by the
 * import offer and the inline "Link…" on an email, so both mint people the same.
 */
export function personDraftFor(address: string, name?: string): EntityDraft {
  return { title: name ?? address, kind: 'person', person: withAddress(emptyPersonMeta(), address) };
}

/** A new organisation from a domain — the domain is its name until renamed. */
export function orgDraftForDomain(domain: string): EntityDraft {
  return {
    title: domain,
    kind: 'organisation',
    organisation: withDomain(emptyOrgMeta(), domain),
  };
}

/**
 * A new person from a phone number — the sibling of `personDraftFor`, for the inline
 * "Link…" on a message or call. The number is its name until renamed.
 */
export function personDraftForNumber(number: string, name?: string): EntityDraft {
  return { title: name ?? number, kind: 'person', person: withNumber(emptyPersonMeta(), number) };
}

export type OfferPlan = {
  /** Cards to mint, in offer order: people first, then organisations. */
  entityDrafts: EntityDraft[];
  /** Existing cards to patch, one entry each. */
  patches: (readonly [string, Partial<Card>])[];
  newPeople: number;
  newOrgs: number;
};

/**
 * One card's whole share of the offer, folded into the payload it already
 * carries — every row aimed at it in a single patch. Two of Jane's addresses
 * pointed at her card would otherwise be two updateCards, each built from the
 * payload as it stood before the batch, and the second would drop the first.
 */
export function patchFor(card: Card, aim: Aim): Partial<Card> {
  const numbers = aim.numbers ?? [];
  if (card.kind === 'organisation') {
    let meta = aim.addresses.reduce(withAddress, card.organisation ?? emptyOrgMeta());
    meta = aim.domains.reduce(withDomain, meta);
    return { organisation: numbers.reduce(withNumber, meta) };
  }
  // A person is never aimed a domain: only an organisation is matched by one.
  const meta = aim.addresses.reduce(withAddress, card.person ?? emptyPersonMeta());
  return { person: numbers.reduce(withNumber, meta) };
}

/**
 * What the ticked rows will do: the cards to mint and the cards to patch.
 *
 * Only the rows passed in are read, so a choice left over from an earlier parse
 * in the same session can never fire unnoticed — what is offered is what is
 * committed. A row aimed at a card that has since gone is dropped rather than
 * resurrecting it.
 *
 * The footer and the commit both read this one derivation, which is what makes
 * the button's promise and the button's effect the same thing by construction.
 */
export function planOffer(
  people: readonly UnseenParticipant[],
  domains: readonly UnseenDomain[],
  choices: ReadonlyMap<string, Choice>,
  cards: readonly Card[],
): OfferPlan {
  const entityDrafts: EntityDraft[] = [];
  const aims = new Map<string, Aim>();
  const aimAt = (id: string): Aim => {
    let aim = aims.get(id);
    if (!aim) aims.set(id, (aim = { addresses: [], domains: [] }));
    return aim;
  };

  for (const p of people) {
    const { on, target } = choiceFor(choices, p.address);
    if (!on) continue;
    if (target === NEW_CARD) entityDrafts.push(personDraftFor(p.address, p.name));
    else aimAt(target).addresses.push(p.address);
  }

  for (const d of domains) {
    const { on, target } = choiceFor(choices, d.domain);
    if (!on) continue;
    if (target === NEW_CARD) entityDrafts.push(orgDraftForDomain(d.domain));
    else aimAt(target).domains.push(d.domain);
  }

  const byId = new Map(cards.map((c) => [c.id, c]));
  const patches = [...aims].flatMap(([id, aim]) => {
    const card = byId.get(id);
    return card ? [[id, patchFor(card, aim)] as const] : [];
  });

  return {
    entityDrafts,
    patches,
    newPeople: entityDrafts.filter((d) => d.kind === 'person').length,
    newOrgs: entityDrafts.filter((d) => d.kind === 'organisation').length,
  };
}
