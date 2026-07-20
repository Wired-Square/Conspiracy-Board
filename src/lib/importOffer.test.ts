import { describe, expect, it } from 'vitest';
import type { Card } from '../types/board';
import {
  NEW_CARD,
  choiceFor,
  orgDraftForDomain,
  patchFor,
  personDraftFor,
  planOffer,
  type Choice,
} from './importOffer';
import type { UnseenDomain, UnseenParticipant } from './roster';

// What ticking a row actually does. These are the claims the import offer makes
// to the user in its own footer — "Add 12 cards + 3 people, 1 organisation" — so
// if they are wrong the button lies, and there is no card deletion to undo it.

let seq = 0;
const card = (kind: Card['kind'], extra: Partial<Card> = {}): Card => ({
  id: extra.id ?? `card_${++seq}`,
  title: 'x',
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: [],
  position: { x: 0, y: 0 },
  kind,
  occurredAt: null,
  occurredAtPrecision: 'minute',
  ...extra,
});

const person = (id: string, ...addresses: string[]) =>
  card('person', { id, person: { addresses } });

const org = (id: string, domains: string[], addresses: string[] = []) =>
  card('organisation', { id, organisation: { addresses, domains } });

const who = (address: string, name?: string): UnseenParticipant => ({
  address,
  name,
  domain: address.split('@')[1] ?? null,
  count: 1,
});

const where = (domain: string): UnseenDomain => ({ domain, count: 1, addressCount: 1 });

/** Tick a row and send it somewhere; untouched rows are simply absent. */
const chose = (...entries: [string, Choice][]) => new Map(entries);
const newCard: Choice = { on: true, target: NEW_CARD };
const at = (id: string): Choice => ({ on: true, target: id });

describe('choiceFor', () => {
  it('defaults a row nobody touched to unticked', () => {
    expect(choiceFor(chose(), 'jane@acme.example')).toEqual({ on: false, target: NEW_CARD });
  });
});

describe('planOffer — nothing happens unless asked', () => {
  it('plans nothing when no row is ticked', () => {
    const plan = planOffer([who('jane@acme.example')], [where('acme.example')], chose(), []);
    expect(plan).toEqual({ entityDrafts: [], patches: [], newPeople: 0, newOrgs: 0 });
  });

  it('ignores a row that is aimed somewhere but left unticked', () => {
    const jane = person('card_jane', 'jane@acme.example');
    const plan = planOffer(
      [who('other@acme.example')],
      [],
      chose(['other@acme.example', { on: false, target: 'card_jane' }]),
      [jane],
    );
    expect(plan.patches).toEqual([]);
    expect(plan.entityDrafts).toEqual([]);
  });

  it('reads only the rows it is given, so a stale choice cannot fire', () => {
    // The row is gone from the offer (a new parse), but the choice lingers.
    const plan = planOffer([], [], chose(['ghost@acme.example', newCard]), []);
    expect(plan.entityDrafts).toEqual([]);
  });
});

describe('planOffer — minting cards', () => {
  it('names a new person by their display name, and holds the address', () => {
    const plan = planOffer([who('jane@acme.example', 'Jane Roe')], [], chose(['jane@acme.example', newCard]), []);
    expect(plan.entityDrafts).toEqual([
      { title: 'Jane Roe', kind: 'person', person: { addresses: ['jane@acme.example'] } },
    ]);
    expect(plan.newPeople).toBe(1);
  });

  it('falls back to the address when the batch never gave a name', () => {
    const plan = planOffer([who('nobody@acme.example')], [], chose(['nobody@acme.example', newCard]), []);
    expect(plan.entityDrafts[0].title).toBe('nobody@acme.example');
  });

  it('mints an organisation from a domain and counts the two kinds apart', () => {
    const plan = planOffer(
      [who('jane@acme.example', 'Jane Roe')],
      [where('acme.example')],
      chose(['jane@acme.example', newCard], ['acme.example', newCard]),
      [],
    );
    expect(plan.newPeople).toBe(1);
    expect(plan.newOrgs).toBe(1);
    expect(plan.entityDrafts[1]).toEqual({
      title: 'acme.example',
      kind: 'organisation',
      organisation: { addresses: [], domains: ['acme.example'] },
    });
  });
});

describe('planOffer — aiming at a card that already exists', () => {
  it("appends a second address to a person rather than making a second Jane", () => {
    // The duplicate test: this is the whole reason the row carries a select.
    const jane = person('card_jane', 'jane@acme.example');
    const plan = planOffer([who('jane.roe@acme.example', 'Jane Roe')], [], chose(['jane.roe@acme.example', at('card_jane')]), [jane]);

    expect(plan.entityDrafts).toEqual([]);
    expect(plan.patches).toEqual([
      ['card_jane', { person: { addresses: ['jane@acme.example', 'jane.roe@acme.example'] } }],
    ]);
  });

  it('folds every row aimed at one card into a single patch', () => {
    // Two updateCards would each be built from the payload as it stood *before*
    // the batch, so the second would drop the first.
    const jane = person('card_jane', 'jane@acme.example');
    const plan = planOffer(
      [who('j.roe@acme.example'), who('jroe@home.example')],
      [],
      chose(['j.roe@acme.example', at('card_jane')], ['jroe@home.example', at('card_jane')]),
      [jane],
    );

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0][1]).toEqual({
      person: { addresses: ['jane@acme.example', 'j.roe@acme.example', 'jroe@home.example'] },
    });
  });

  it('gives an organisation both the address and the domain aimed at it, in one patch', () => {
    const acme = org('card_acme', ['acme.example']);
    const plan = planOffer(
      [who('legal@acme.example')],
      [where('acme-legal.example')],
      chose(['legal@acme.example', at('card_acme')], ['acme-legal.example', at('card_acme')]),
      [acme],
    );

    expect(plan.patches).toEqual([
      [
        'card_acme',
        {
          organisation: {
            addresses: ['legal@acme.example'],
            domains: ['acme.example', 'acme-legal.example'],
          },
        },
      ],
    ]);
  });

  it('normalises on the way in and never doubles an address the card has', () => {
    const jane = person('card_jane', 'jane@acme.example');
    const plan = planOffer([who('JANE@ACME.EXAMPLE')], [], chose(['JANE@ACME.EXAMPLE', at('card_jane')]), [jane]);
    expect(plan.patches[0][1]).toEqual({ person: { addresses: ['jane@acme.example'] } });
  });

  it('drops a row aimed at a card that has since gone, rather than resurrecting it', () => {
    const plan = planOffer([who('jane@acme.example')], [], chose(['jane@acme.example', at('card_gone')]), []);
    expect(plan.patches).toEqual([]);
    expect(plan.entityDrafts).toEqual([]);
  });

  it('starts a payload from empty when the target card has none', () => {
    // A card switched to person by hand carries no person payload until now.
    const bare = card('person', { id: 'card_bare' });
    const plan = planOffer([who('jane@acme.example')], [], chose(['jane@acme.example', at('card_bare')]), [bare]);
    expect(plan.patches[0][1]).toEqual({ person: { addresses: ['jane@acme.example'] } });
  });
});

// The inline "Link…" on an email and the import offer both mint and patch
// through these, so a person made either way is the same person.

describe('personDraftFor', () => {
  it('names the person by their display name, falling back to the address', () => {
    expect(personDraftFor('jane@acme.example', 'Jane Doe')).toEqual({
      title: 'Jane Doe',
      kind: 'person',
      person: { addresses: ['jane@acme.example'] },
    });
    expect(personDraftFor('Jane@Acme.example').title).toBe('Jane@Acme.example');
    expect(personDraftFor('Jane@Acme.example').person).toEqual({ addresses: ['jane@acme.example'] });
  });
});

describe('orgDraftForDomain', () => {
  it('names the organisation by its domain and claims it', () => {
    expect(orgDraftForDomain('acme.example')).toEqual({
      title: 'acme.example',
      kind: 'organisation',
      organisation: { addresses: [], domains: ['acme.example'] },
    });
  });
});

describe('patchFor', () => {
  it('folds an address into a person, keeping what they already hold', () => {
    const jane = person('p_jane', 'jane@acme.example');
    expect(patchFor(jane, { addresses: ['jane@personal.example'], domains: [] })).toEqual({
      person: { addresses: ['jane@acme.example', 'jane@personal.example'] },
    });
  });

  it('folds an address into an organisation as one of its own', () => {
    const acme = org('o_acme', ['acme.example']);
    expect(patchFor(acme, { addresses: ['legal@acme.example'], domains: [] })).toEqual({
      organisation: { addresses: ['legal@acme.example'], domains: ['acme.example'] },
    });
  });
});
