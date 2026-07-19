import { describe, expect, it } from 'vitest';
import type { Card } from '../types/board';
import { cardMatchesEntity } from './search';

const base = (kind: Card['kind'], extra: Partial<Card> = {}): Card => ({
  id: 'c',
  title: '',
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

describe('cardMatchesEntity', () => {
  it('matches a person by name, address or number', () => {
    const p = base('person', {
      title: 'Jane Doe',
      person: { addresses: ['jane@acme.com'], numbers: ['+61403123456'] },
    });
    expect(cardMatchesEntity(p, 'jane')).toBe(true); // the name (title)
    expect(cardMatchesEntity(p, 'acme.com')).toBe(true); // an address
    expect(cardMatchesEntity(p, '403')).toBe(true); // a number
    expect(cardMatchesEntity(p, 'nope')).toBe(false);
  });

  it('matches an organisation by name, address, domain or number', () => {
    const o = base('organisation', {
      title: 'Acme Inc',
      organisation: { addresses: ['info@acme.com'], domains: ['acme.com'], numbers: ['+61298765432'] },
    });
    expect(cardMatchesEntity(o, 'acme inc')).toBe(true);
    expect(cardMatchesEntity(o, 'acme.com')).toBe(true);
    expect(cardMatchesEntity(o, '9876')).toBe(true);
  });

  it('matches an email by its participants, not its subject', () => {
    const email = base('email', {
      title: 'Re: Budget',
      email: {
        from: { name: 'Jane', address: 'jane@acme.com' },
        to: [],
        cc: [],
        messageId: null,
        inReplyTo: null,
        attachments: [],
      },
    });
    expect(cardMatchesEntity(email, 'jane')).toBe(true); // participant name
    expect(cardMatchesEntity(email, 'budget')).toBe(false); // the subject is not an identifier
  });

  it('matches a message by its party name or number', () => {
    const msg = base('message', {
      message: { from: { name: 'Mhairi', address: '+61400000000' }, to: [] },
    });
    expect(cardMatchesEntity(msg, 'mhairi')).toBe(true);
    expect(cardMatchesEntity(msg, '400000000')).toBe(true);
  });

  it('does NOT match an argument card by its title or notes', () => {
    const ev = base('evidence', { title: 'The meeting', notes: 'jane was there' });
    expect(cardMatchesEntity(ev, 'meeting')).toBe(false);
    expect(cardMatchesEntity(ev, 'jane')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(cardMatchesEntity(base('evidence', { title: 'x' }), '')).toBe(true);
  });
});
