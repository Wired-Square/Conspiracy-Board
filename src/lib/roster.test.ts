import { describe, expect, it } from 'vitest';
import type { Card, EmailMeta } from '../types/board';
import {
  actorIds,
  buildRoster,
  emailParticipants,
  entitiesForAddress,
  entitiesForNumber,
  entityForAddress,
  isLinkedDocument,
  participantsOf,
  relationsOf,
  suggestedLinks,
  unaccountedAddresses,
  unseenDomains,
  unseenParticipants,
} from './roster';

// Card factories, kept tiny: only the fields the roster reads matter, and
// spelling out a whole Card each time would bury what each test is about.

let seq = 0;
const card = (kind: Card['kind'], extra: Partial<Card> = {}): Card => ({
  id: extra.id ?? `card_${++seq}`,
  title: 'x',
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterId: null,
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

const mail = (id: string, from: string, to: string[] = [], cc: string[] = []) =>
  card('email', {
    id,
    email: {
      from: { address: from },
      to: to.map((address) => ({ address })),
      cc: cc.map((address) => ({ address })),
      messageId: `<${id}@x>`,
      inReplyTo: null,
      attachments: [],
    },
  });

const draft = (from: string, to: string[] = [], name?: string) => ({
  email: {
    from: { address: from, ...(name ? { name } : {}) },
    to: to.map((address) => ({ address })),
    cc: [],
    messageId: null,
    inReplyTo: null,
    attachments: [],
  } as EmailMeta,
});

describe('emailParticipants', () => {
  it('takes from, to and cc, normalised and deduped', () => {
    const m = mail('e1', 'Jane@ACME.com', ['bob@acme.com', 'jane@acme.com'], ['cc@acme.com']);
    expect(emailParticipants(m.email!).sort()).toEqual([
      'bob@acme.com',
      'cc@acme.com',
      'jane@acme.com',
    ]);
  });

  it('copes with a message that has no sender', () => {
    const m = card('email', { email: { from: null, to: [], cc: [], messageId: null, inReplyTo: null, attachments: [] } });
    expect(emailParticipants(m.email!)).toEqual([]);
  });
});

describe('buildRoster', () => {
  it('files an email under the people on it, whether they sent or received it', () => {
    const roster = buildRoster([
      person('p_jane', 'jane@acme.com'),
      person('p_bob', 'bob@acme.com'),
      mail('e1', 'jane@acme.com', ['bob@acme.com']),
    ]);
    expect(roster.peopleByComm.get('e1')?.sort()).toEqual(['p_bob', 'p_jane']);
    expect(participantsOf(roster, 'p_jane')).toContain('e1');
    expect(participantsOf(roster, 'p_bob')).toContain('e1');
  });

  it('matches regardless of the case either side was written in', () => {
    const roster = buildRoster([person('p_jane', 'Jane@Acme.COM'), mail('e1', 'jANE@acme.com')]);
    expect(roster.peopleByComm.get('e1')).toEqual(['p_jane']);
  });

  it('files an email under an organisation by its domain', () => {
    const roster = buildRoster([org('o_acme', ['acme.com']), mail('e1', 'anyone@acme.com')]);
    expect(roster.orgsByComm.get('e1')).toEqual(['o_acme']);
  });

  it('files an email under an organisation by an address it holds in its own right', () => {
    // legal@ is nobody's personal mail — and the address need not even be at a
    // domain the organisation owns, e.g. its solicitor's.
    const roster = buildRoster([
      org('o_acme', ['acme.com'], ['acme@lawfirm.example']),
      mail('e1', 'acme@lawfirm.example'),
    ]);
    expect(roster.orgsByComm.get('e1')).toEqual(['o_acme']);
  });

  it('files one email under both a person and an organisation — the and/or', () => {
    const roster = buildRoster([
      person('p_jane', 'jane@acme.com'),
      org('o_acme', ['acme.com']),
      mail('e1', 'jane@acme.com'),
    ]);
    expect(roster.peopleByComm.get('e1')).toEqual(['p_jane']);
    expect(roster.orgsByComm.get('e1')).toEqual(['o_acme']);
  });

  it('follows a person across their several addresses', () => {
    const roster = buildRoster([
      person('p_jane', 'jane@acme.com', 'jane@personal.example'),
      mail('e1', 'jane@acme.com'),
      mail('e2', 'someone@x.example', ['jane@personal.example']),
    ]);
    expect(participantsOf(roster, 'p_jane').filter((id) => id.startsWith('e')).sort()).toEqual(['e1', 'e2']);
  });

  it('derives person → organisation from their address domain', () => {
    // Membership for free. If this is wrong the feature is wrong.
    const roster = buildRoster([person('p_jane', 'jane@acme.com'), org('o_acme', ['acme.com'])]);
    expect(roster.orgsByPerson.get('p_jane')).toEqual(['o_acme']);
    expect(roster.peopleByOrg.get('o_acme')).toEqual(['p_jane']);
  });

  it('does not invent a membership from a subdomain', () => {
    // mail.acme.com is not acme.com. An organisation wanting both says so.
    const roster = buildRoster([
      person('p_jane', 'jane@mail.acme.com'),
      org('o_acme', ['acme.com']),
    ]);
    expect(roster.orgsByPerson.get('p_jane')).toBeUndefined();
  });

  it('ignores a payload left behind by a card that changed kind', () => {
    // Switching kind does not clear the old payload, so an evidence card can
    // still carry `person`. `kind` is the only authority.
    const stale = card('evidence', { id: 'c_stale', person: { addresses: ['jane@acme.com'] } });
    const roster = buildRoster([stale, mail('e1', 'jane@acme.com')]);
    expect(roster.personByAddress.has('jane@acme.com')).toBe(false);
    expect(roster.peopleByComm.get('e1')).toBeUndefined();
  });

  it('gives a contested address to the first claimant, every time', () => {
    const roster = buildRoster([
      person('p_first', 'shared@acme.com'),
      person('p_second', 'shared@acme.com'),
      mail('e1', 'shared@acme.com'),
    ]);
    expect(roster.personByAddress.get('shared@acme.com')).toBe('p_first');
    expect(roster.peopleByComm.get('e1')).toEqual(['p_first']);
  });

  it('leaves an email with no known participants unfiled rather than guessing', () => {
    const roster = buildRoster([person('p_jane', 'jane@acme.com'), mail('e1', 'noreply@sentry.io')]);
    expect(roster.peopleByComm.get('e1')).toBeUndefined();
    expect(roster.orgsByComm.get('e1')).toBeUndefined();
  });
});

describe('participantsOf', () => {
  const cards = [
    person('p_jane', 'jane@acme.com'),
    org('o_acme', ['acme.com']),
    mail('e1', 'jane@acme.com'),
  ];
  const roster = buildRoster(cards);

  it('gives an email its people and organisations', () => {
    expect(participantsOf(roster, 'e1').sort()).toEqual(['o_acme', 'p_jane']);
  });

  it('gives a person their emails and organisations', () => {
    expect(participantsOf(roster, 'p_jane').sort()).toEqual(['e1', 'o_acme']);
  });

  it('gives an organisation its emails and people', () => {
    expect(participantsOf(roster, 'o_acme').sort()).toEqual(['e1', 'p_jane']);
  });

  it('gives an unrelated card nothing', () => {
    expect(participantsOf(roster, 'card_nope')).toEqual([]);
  });
});

describe('unseenParticipants', () => {
  it('ranks by how many messages an address appears in', () => {
    const roster = buildRoster([]);
    const seen = unseenParticipants(
      [draft('rare@x.example'), draft('common@x.example'), draft('common@x.example')],
      roster,
    );
    expect(seen.map((p) => p.address)).toEqual(['common@x.example', 'rare@x.example']);
    expect(seen[0].count).toBe(2);
  });

  it('counts a message once, however many fields the address is in', () => {
    const seen = unseenParticipants([draft('jane@x.example', ['jane@x.example'])], buildRoster([]));
    expect(seen[0].count).toBe(1);
  });

  it('leaves out addresses a person or organisation already claims', () => {
    const roster = buildRoster([person('p_jane', 'jane@acme.com'), org('o_acme', [], ['legal@acme.com'])]);
    const seen = unseenParticipants(
      [draft('jane@acme.com', ['legal@acme.com', 'bob@acme.com'])],
      roster,
    );
    expect(seen.map((p) => p.address)).toEqual(['bob@acme.com']);
  });

  it('keeps a display name for the row, and the domain', () => {
    const seen = unseenParticipants([draft('jane@acme.com', [], 'Jane Roe')], buildRoster([]));
    expect(seen[0]).toMatchObject({ name: 'Jane Roe', domain: 'acme.com' });
  });

  it('orders equal counts stably rather than by chance', () => {
    const seen = unseenParticipants([draft('b@x.example', ['a@x.example'])], buildRoster([]));
    expect(seen.map((p) => p.address)).toEqual(['a@x.example', 'b@x.example']);
  });
});

describe('unseenDomains', () => {
  it('offers a domain no organisation claims, with its reach', () => {
    const seen = unseenDomains(
      [draft('jane@acme.com', ['bob@acme.com']), draft('jane@acme.com')],
      buildRoster([]),
    );
    expect(seen).toEqual([{ domain: 'acme.com', count: 2, addressCount: 2 }]);
  });

  it('leaves out a domain an organisation already claims', () => {
    const seen = unseenDomains([draft('jane@acme.com')], buildRoster([org('o_acme', ['acme.com'])]));
    expect(seen).toEqual([]);
  });

  it('never offers freemail as an organisation', () => {
    // "Organisation: gmail.com" is not merely noise, it is wrong.
    const seen = unseenDomains(
      [draft('someone@gmail.com', ['other@bigpond.com', 'real@acme.com'])],
      buildRoster([]),
    );
    expect(seen.map((d) => d.domain)).toEqual(['acme.com']);
  });

  it('still matches a freemail domain an organisation deliberately claims', () => {
    // The list suppresses the offer, not the matching.
    const roster = buildRoster([org('o_odd', ['gmail.com']), mail('e1', 'someone@gmail.com')]);
    expect(roster.orgsByComm.get('e1')).toEqual(['o_odd']);
  });
});

describe('direction — who sent it, who got it', () => {
  it('files a sender under sent and a recipient under received', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const bob = person('p_bob', 'bob@other.example');
    const roster = buildRoster([jane, bob, mail('e1', 'jane@acme.example', ['bob@other.example'])]);

    expect(roster.commsSentBy.get('p_jane')).toEqual(['e1']);
    expect(roster.commsReceivedBy.get('p_jane')).toBeUndefined();
    expect(roster.commsReceivedBy.get('p_bob')).toEqual(['e1']);
    expect(roster.commsSentBy.get('p_bob')).toBeUndefined();
  });

  it('counts cc as received — the difference from to is etiquette', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const roster = buildRoster([jane, mail('e1', 'x@x.example', [], ['jane@acme.example'])]);
    expect(roster.commsReceivedBy.get('p_jane')).toEqual(['e1']);
  });

  it('files someone on both ends of one message under each, once', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const roster = buildRoster([
      jane,
      mail('e1', 'jane@acme.example', ['x@x.example'], ['jane@acme.example']),
    ]);
    expect(roster.commsSentBy.get('p_jane')).toEqual(['e1']);
    expect(roster.commsReceivedBy.get('p_jane')).toEqual(['e1']);
  });

  it('has an organisation send the mail that leaves through its domain', () => {
    // The same inference that puts the org on the message at all: it went out
    // through their mail. Filing it any other way would leave the org on an
    // email it neither sent nor received.
    const acme = org('o_acme', ['acme.example']);
    const roster = buildRoster([acme, mail('e1', 'jane@acme.example', ['x@x.example'])]);

    expect(roster.commsSentBy.get('o_acme')).toEqual(['e1']);
    expect(roster.commsReceivedBy.get('o_acme')).toBeUndefined();
    // And it is still simply *on* the email, whichever way participantsOf is asked.
    expect(participantsOf(roster, 'o_acme')).toContain('e1');
  });

  it('says nothing about an address no card claims', () => {
    const roster = buildRoster([mail('e1', 'nobody@x.example', ['also@x.example'])]);
    expect(roster.commsSentBy.size).toBe(0);
    expect(roster.commsReceivedBy.size).toBe(0);
  });

  it('ignores a lingering person payload on a card that is no longer one', () => {
    // kind is the only authority; switching it leaves the payload behind.
    const stale = card('evidence', { id: 'c_stale', person: { addresses: ['jane@acme.example'] } });
    const roster = buildRoster([stale, mail('e1', 'jane@acme.example')]);
    expect(roster.commsSentBy.get('c_stale')).toBeUndefined();
  });
});

describe('suggestedLinks', () => {
  // Jane is on one email; Acme owns the domain that email came through, so the
  // three of them are all participants of each other.
  const jane = person('p_jane', 'jane@acme.example');
  const acme = org('o_acme', ['acme.example']);
  const email = mail('e1', 'jane@acme.example', ['bob@other.example']);
  const cards = [jane, acme, email];
  const roster = buildRoster(cards);
  const all = new Set(cards.map((c) => c.id));

  it('strings the focused card to its participants', () => {
    expect(suggestedLinks(roster, 'e1', all, []).sort()).toEqual(['o_acme', 'p_jane']);
  });

  it('says nothing about a card nobody can see', () => {
    expect(suggestedLinks(roster, 'e1', new Set(['e1']), [])).toEqual([]);
  });

  it('says nothing when the focused card is itself hidden', () => {
    expect(suggestedLinks(roster, 'e1', new Set(['p_jane', 'o_acme']), [])).toEqual([]);
  });

  it('drops a participant already joined by hand — the suggestion has been taken', () => {
    // Either direction: string has no direction the roster cares about.
    expect(suggestedLinks(roster, 'e1', all, [{ source: 'e1', target: 'p_jane' }])).toEqual([
      'o_acme',
    ]);
    expect(suggestedLinks(roster, 'e1', all, [{ source: 'p_jane', target: 'e1' }])).toEqual([
      'o_acme',
    ]);
  });

  it('ignores string between two other cards', () => {
    const links = [{ source: 'p_jane', target: 'o_acme' }];
    expect(suggestedLinks(roster, 'e1', all, links).sort()).toEqual(['o_acme', 'p_jane']);
  });

  it('has nothing to say about a card with no addresses', () => {
    const lonely = card('evidence', { id: 'c_lonely' });
    const r = buildRoster([...cards, lonely]);
    expect(suggestedLinks(r, 'c_lonely', new Set([...all, 'c_lonely']), [])).toEqual([]);
  });
});

describe('unaccountedAddresses', () => {
  it('is empty when every address on the message has a card', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const bob = person('p_bob', 'bob@other.example');
    const email = mail('e1', 'jane@acme.example', ['bob@other.example']);
    expect(unaccountedAddresses(email, buildRoster([jane, bob, email]))).toEqual([]);
  });

  it('names the addresses nobody claims', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const email = mail('e1', 'jane@acme.example', ['stranger@x.example']);
    expect(unaccountedAddresses(email, buildRoster([jane, email]))).toEqual([
      'stranger@x.example',
    ]);
  });

  it('counts an address whose domain an organisation owns', () => {
    // One link is enough: Acme owning the domain accounts for the address, even
    // before anyone names the person behind it.
    const acme = org('o_acme', ['acme.example']);
    const email = mail('e1', 'jane@acme.example');
    expect(unaccountedAddresses(email, buildRoster([acme, email]))).toEqual([]);
  });

  it('counts an address an organisation holds in its own right', () => {
    const acme = org('o_acme', [], ['legal@acme.example']);
    const email = mail('e1', 'legal@acme.example');
    expect(unaccountedAddresses(email, buildRoster([acme, email]))).toEqual([]);
  });

  it('has nothing to say about a card that is not an email', () => {
    expect(unaccountedAddresses(card('document', { id: 'd1' }), buildRoster([]))).toEqual([]);
    expect(unaccountedAddresses(person('p1', 'a@x.example'), buildRoster([]))).toEqual([]);
  });
});

describe('actorIds / isLinkedDocument', () => {
  const doc = card('document', { id: 'd1' });
  const jane = person('p_jane', 'jane@acme.example');
  const evidence = card('evidence', { id: 'c_claim' });
  const link = (source: string, target: string) => [
    { id: 'e1', source, target, kind: 'red-string' as const },
  ];

  it('finds the actors and nothing else', () => {
    expect(actorIds([doc, jane, evidence, org('o_acme', ['acme.example'])])).toEqual(
      new Set(['p_jane', 'o_acme']),
    );
  });

  it('is linked when string reaches an actor, either way round', () => {
    const actors = actorIds([doc, jane]);
    expect(isLinkedDocument('d1', link('d1', 'p_jane'), actors)).toBe(true);
    expect(isLinkedDocument('d1', link('p_jane', 'd1'), actors)).toBe(true);
  });

  it('is not linked with no string at all', () => {
    expect(isLinkedDocument('d1', [], actorIds([doc, jane]))).toBe(false);
  });

  it('is not linked by string to something that is not an actor', () => {
    // A document tied only to a claim still names nobody.
    expect(isLinkedDocument('d1', link('d1', 'c_claim'), actorIds([doc, evidence]))).toBe(
      false,
    );
  });

  it('ignores string between two other cards', () => {
    expect(isLinkedDocument('d1', link('p_jane', 'c_claim'), actorIds([jane]))).toBe(false);
  });
});

describe('relationsOf — actors', () => {
  it('is the people and organisations, and never the mail', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const acme = org('o_acme', ['acme.example']);
    const cards = [mail('e1', 'jane@acme.example'), acme, jane];

    // Jane's mail is real and derived, but it has a direction and belongs to
    // mailOf; only the actors are here.
    expect(relationsOf(buildRoster(cards), 'p_jane', cards).actors.map((c) => c.id)).toEqual([
      'o_acme',
    ]);
  });

  it('reads people before organisations, then by title', () => {
    const acme = org('o_acme', ['acme.example']);
    const zed = { ...person('p_zed', 'zed@acme.example'), title: 'Zed' };
    const amy = { ...person('p_amy', 'amy@acme.example'), title: 'Amy' };
    const cards = [acme, zed, amy];

    expect(relationsOf(buildRoster(cards), 'o_acme', cards).actors.map((c) => c.id)).toEqual([
      'p_amy',
      'p_zed',
    ]);
  });

  it('drops an id with no card behind it rather than showing a hole', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const acme = org('o_acme', ['acme.example']);
    const roster = buildRoster([jane, acme]);
    // The roster was built when Acme existed; the list is drawn after it went.
    expect(relationsOf(roster, 'p_jane', [jane]).actors).toEqual([]);
  });
});

describe('relationsOf — mail', () => {
  it('splits by direction, newest first', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const older = { ...mail('e_old', 'jane@acme.example'), occurredAt: '2024-01-01T00:00:00.000Z' };
    const newer = { ...mail('e_new', 'jane@acme.example'), occurredAt: '2024-06-01T00:00:00.000Z' };
    const inbound = { ...mail('e_in', 'x@x.example', ['jane@acme.example']), occurredAt: '2024-03-01T00:00:00.000Z' };
    const cards = [older, newer, inbound, jane];

    const { sent, received } = relationsOf(buildRoster(cards), 'p_jane', cards);
    expect(sent.map((c) => c.id)).toEqual(['e_new', 'e_old']);
    expect(received.map((c) => c.id)).toEqual(['e_in']);
  });

  it('sorts undated mail last', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const dated = { ...mail('e_dated', 'jane@acme.example'), occurredAt: '2024-01-01T00:00:00.000Z' };
    const undated = mail('e_undated', 'jane@acme.example');
    const cards = [undated, dated, jane];

    expect(relationsOf(buildRoster(cards), 'p_jane', cards).sent.map((c) => c.id)).toEqual([
      'e_dated',
      'e_undated',
    ]);
  });

  it('gives a message no mail of its own, but still its actors', () => {
    const jane = person('p_jane', 'jane@acme.example');
    const cards = [jane, mail('e1', 'jane@acme.example')];
    const { actors, sent, received } = relationsOf(buildRoster(cards), 'e1', cards);
    expect(actors.map((c) => c.id)).toEqual(['p_jane']);
    expect({ sent, received }).toEqual({ sent: [], received: [] });
  });
});

describe('entityForAddress', () => {
  it('prefers the person who holds the address', () => {
    const cards = [
      person('p_jane', 'jane@acme.example'),
      org('o_acme', ['acme.example'], ['jane@acme.example']),
    ];
    expect(entityForAddress(buildRoster(cards), 'JANE@acme.example')).toEqual({
      id: 'p_jane',
      via: 'person',
    });
  });

  it('falls back to the organisation that holds the address itself', () => {
    const cards = [org('o_acme', [], ['legal@acme.example'])];
    expect(entityForAddress(buildRoster(cards), 'legal@acme.example')).toEqual({
      id: 'o_acme',
      via: 'org-address',
    });
  });

  it('then to the organisation that owns the domain — an inference', () => {
    const cards = [org('o_acme', ['acme.example'])];
    expect(entityForAddress(buildRoster(cards), 'someone@acme.example')).toEqual({
      id: 'o_acme',
      via: 'org-domain',
    });
  });

  it('is null when nobody claims the address or its domain', () => {
    expect(entityForAddress(buildRoster([]), 'nobody@nowhere.example')).toBeNull();
  });
});

describe('buildRoster — person ↔ organisation from a shared email', () => {
  it('links a person and an organisation that appear on the same message', () => {
    // Alex is on the invoice; TPP sent it, by its domain. The email ties the two
    // even though Alex's own address is at a different domain.
    const roster = buildRoster([
      person('p_alex', 'alex@receptiveit.example'),
      org('o_tpp', ['tpp.example']),
      mail('e1', 'support@tpp.example', ['alex@receptiveit.example']),
    ]);
    expect(roster.orgsByPerson.get('p_alex')).toContain('o_tpp');
    expect(roster.peopleByOrg.get('o_tpp')).toContain('p_alex');
  });

  it('does not double a link derivable both by domain and by a shared email', () => {
    const roster = buildRoster([
      person('p_jane', 'jane@acme.example'),
      org('o_acme', ['acme.example']),
      mail('e1', 'jane@acme.example', ['boss@acme.example']),
    ]);
    expect(roster.orgsByPerson.get('p_jane')).toEqual(['o_acme']);
    expect(roster.peopleByOrg.get('o_acme')).toEqual(['p_jane']);
  });
});

describe('entitiesForAddress', () => {
  it('returns the person and the organisation that owns the domain', () => {
    const cards = [person('p_alex', 'alex@receptiveit.example'), org('o_rec', ['receptiveit.example'])];
    expect(entitiesForAddress(buildRoster(cards), 'alex@receptiveit.example')).toEqual({
      personId: 'p_alex',
      org: { id: 'o_rec', via: 'org-domain' },
    });
  });

  it('gives an organisation alone, by its domain, when no person holds it', () => {
    const cards = [org('o_tpp', ['tpp.example'])];
    expect(entitiesForAddress(buildRoster(cards), 'support@tpp.example')).toEqual({
      org: { id: 'o_tpp', via: 'org-domain' },
    });
  });

  it('prefers an address the organisation holds outright over its domain', () => {
    const cards = [org('o_acme', ['acme.example'], ['legal@lawfirm.example'])];
    expect(entitiesForAddress(buildRoster(cards), 'legal@lawfirm.example')).toEqual({
      org: { id: 'o_acme', via: 'org-address' },
    });
  });

  it('is empty for an address nobody holds', () => {
    expect(entitiesForAddress(buildRoster([]), 'nobody@nowhere.example')).toEqual({});
  });
});

describe('messages and calls match actors by number', () => {
  const withNumber = (id: string, ...numbers: string[]) =>
    card('person', { id, person: { addresses: [], numbers } });
  const message = (id: string, from: string, to: string[] = []) =>
    card('message', {
      id,
      message: { from: { address: from }, to: to.map((address) => ({ address })) },
    });

  it('links a message to the person on it, matching despite spacing and country code', () => {
    const cards = [withNumber('p_jane', '0400 123 456'), message('m1', 'x', ['0400123456'])];
    const roster = buildRoster(cards);
    // The message knows Jane is on it, and Jane's relations include the message —
    // the same participant machinery email uses, so suggestedLinks offers the string.
    expect(participantsOf(roster, 'm1')).toContain('p_jane');
    expect(participantsOf(roster, 'p_jane')).toContain('m1');
  });

  it('links a call the same way', () => {
    const call = card('call', { id: 'c1', call: { from: { address: '02 9000 0000' }, to: [] } });
    const cards = [withNumber('p_org', '0290000000'), call];
    expect(participantsOf(buildRoster(cards), 'c1')).toContain('p_org');
  });

  it('does not match a different number', () => {
    const cards = [withNumber('p_jane', '0400 123 456'), message('m1', 'x', ['0400 000 000'])];
    expect(participantsOf(buildRoster(cards), 'm1')).not.toContain('p_jane');
  });
});

describe('entitiesForNumber', () => {
  const personNum = (id: string, ...numbers: string[]) =>
    card('person', { id, person: { addresses: [], numbers } });
  const orgNum = (id: string, ...numbers: string[]) =>
    card('organisation', { id, organisation: { addresses: [], domains: [], numbers } });
  const roster = buildRoster([personNum('p1', '0403 123 456'), orgNum('o1', '02 9876 5432')]);

  it('resolves a number to the person who holds it, despite spacing and country code', () => {
    expect(entitiesForNumber(roster, '+61 403 123 456')).toEqual({ personId: 'p1' });
  });

  it('resolves an organisation number as via org-number (no domain tier)', () => {
    expect(entitiesForNumber(roster, '0298765432')).toEqual({ org: { id: 'o1', via: 'org-number' } });
  });

  it('is empty for an unknown number', () => {
    expect(entitiesForNumber(roster, '0400 000 000')).toEqual({});
  });
});
