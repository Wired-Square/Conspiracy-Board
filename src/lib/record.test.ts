import { describe, expect, it } from 'vitest';
import type { Card } from '../types/board';
import { buildRoster } from './roster';
import { recordRows, whatsLoose, whoLine } from './record';

const card = (id: string, kind: Card['kind'], extra: Partial<Card> = {}): Card => ({
  id,
  title: id,
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

const mail = (id: string, from: string, to: string[], occurredAt: string | null = null) =>
  card(id, 'email', {
    occurredAt,
    email: {
      from: { address: from, ...(from === 'jane@acme.com' ? { name: 'Jane' } : {}) },
      to: to.map((address) => ({ address })),
      cc: [],
      messageId: `<${id}@x>`,
      inReplyTo: null,
      attachments: [],
    },
  });

const jane = card('p_jane', 'person', { person: { addresses: ['jane@acme.com'] } });

describe('whoLine', () => {
  it('names the sender and the first recipient, counting the rest', () => {
    expect(whoLine(mail('m', 'jane@acme.com', ['bob@acme.com', 'cc@acme.com']))).toBe('Jane → bob@acme.com +1');
    expect(whoLine(card('d', 'document'))).toBeNull();
  });
});

describe('whatsLoose', () => {
  const roster = buildRoster([jane]);

  it('counts the addresses no card claims', () => {
    expect(whatsLoose(mail('m', 'jane@acme.com', ['bob@acme.com']), roster, [], new Set())).toBe('1 address unaccounted');
    expect(whatsLoose(mail('m', 'jane@acme.com', []), roster, [], new Set())).toBeNull();
  });

  it('asks a document for string to an actor', () => {
    const doc = card('d', 'document');
    expect(whatsLoose(doc, roster, [], new Set(['p_jane']))).toBe('names nobody');
    const tie = { id: 'c', source: 'd', target: 'p_jane', kind: 'red-string' as const };
    expect(whatsLoose(doc, roster, [tie], new Set(['p_jane']))).toBeNull();
  });
});

describe('recordRows', () => {
  it('keeps the record only, newest first, and counts the loose', () => {
    const older = mail('older', 'jane@acme.com', [], '2024-01-01T00:00:00.000Z');
    const newer = mail('newer', 'bob@acme.com', [], '2024-02-01T00:00:00.000Z');
    const cards = [jane, older, newer];
    const { rows, looseCount } = recordRows(cards, cards, buildRoster(cards), []);
    expect(rows.map((r) => r.card.id)).toEqual(['newer', 'older']);
    expect(looseCount).toBe(1);
  });
});
