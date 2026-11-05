import { describe, expect, it } from 'vitest';
import type { Card, Connection } from '../types/board';
import { isMasked, isRedacted, pickableCards, seenCards, seenConnections, type MaskView } from './mask';
import { cardMatches, cardMatchesWithDocs, normaliseQuery } from './search';
import { searchMatchIds, visibleCards } from './visibility';
import { seenMediaRows, mediaRowMatchesWithDocs, type MediaRow } from './maintenance';

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  title: `${id} title`,
  notes: `${id} notes`,
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: ['k'],
  kind: 'person',
  occurredAt: '2024-03-01T00:00:00Z',
  occurredAtPrecision: 'day',
  position: { x: 4, y: 5 },
  ...over,
});

const secret = card('secret', {
  confidential: true,
  imageFile: 'photo.jpg',
  person: { addresses: ['jo@example.com'] },
  grade: 'confirmed',
});
const open = card('open');
const cards = [open, secret];
const link: Connection = { id: 'l', source: 'open', target: 'secret', kind: 'red-string', label: 'knows' };

const view = (over: Partial<MaskView> = {}): MaskView => ({ mask: true, showMasked: true, unmaskedId: null, ...over });

describe('isMasked', () => {
  it('masks a confidential card while Mask is on, unless it is the one unmasked', () => {
    expect(isMasked(secret, view())).toBe(true);
    expect(isMasked(open, view())).toBe(false);
    expect(isMasked(secret, view({ mask: false }))).toBe(false);
    expect(isMasked(secret, view({ unmaskedId: 'secret' }))).toBe(false);
  });
});

describe('seenCards', () => {
  it('redacts a masked card down to its kind, date, place and clusters', () => {
    const [, shown] = seenCards(cards, view());
    expect(shown).toEqual({
      id: 'secret',
      title: 'Redacted',
      notes: '',
      imageUrl: null,
      imageFile: null,
      imageCrop: null,
      imageMeta: null,
      clusterIds: ['k'],
      position: { x: 4, y: 5 },
      kind: 'person',
      occurredAt: '2024-03-01T00:00:00Z',
      occurredAtPrecision: 'day',
      confidential: true,
    });
    expect(isRedacted(shown)).toBe(true);
  });

  it('keeps the same objects across reads, and the array itself when nothing is masked', () => {
    expect(seenCards(cards, view())[1]).toBe(seenCards(cards, view())[1]);
    expect(seenCards(cards, view({ mask: false }))).toBe(cards);
    expect(seenCards(cards, view({ unmaskedId: 'secret' }))).toBe(cards);
  });

  it('leaves a masked card and its strings out when Show Masked Items is off', () => {
    const hiding = view({ showMasked: false });
    expect(seenCards(cards, hiding)).toEqual([open]);
    expect(seenConnections([link], cards, hiding)).toEqual([]);
    expect(seenConnections([link], cards, view())).toEqual([link]);
    expect(seenConnections([link], cards, view({ showMasked: false, mask: false }))).toEqual([link]);
  });

  it('keeps redacted cards out of pickers', () => {
    expect(pickableCards(seenCards(cards, view()))).toEqual([open]);
  });
});

describe('search over masked cards', () => {
  const seen = seenCards(cards, view());
  const q = (raw: string) => normaliseQuery(raw);

  it('never matches a redacted card, even on what it shows', () => {
    for (const raw of ['redacted', 'jo@example', 'secret']) {
      expect(seen.some((c) => isRedacted(c) && cardMatches(c, q(raw)))).toBe(false);
    }
    expect(cardMatchesWithDocs(seen[1], q('photo'), new Set(['photo.jpg']))).toBe(false);
  });

  it('drops it from the record and dims it on the board, but an empty search keeps it', () => {
    expect(visibleCards(seen, [], false, 'jo@').map((c) => c.id)).toEqual([]);
    expect(visibleCards(seen, [], false, '').map((c) => c.id)).toEqual(['open', 'secret']);
    expect([...searchMatchIds(seen, new Set(['open', 'secret']), 'title')!]).toEqual(['open']);
  });
});

describe('seenMediaRows', () => {
  const row = (file: string, cardId: string): MediaRow => ({
    file,
    size: 1,
    onDisk: true,
    owner: { cardId, title: `${cardId} title`, cardKind: 'person', mediaKind: 'image' },
    status: 'ok',
  });
  const rows = [row('photo.jpg', 'secret'), row('other.jpg', 'open')];

  it('redacts a file a masked card carries, never matches it, and drops it when masked items are hidden', () => {
    const [masked, other] = seenMediaRows(rows, cards, view());
    expect(masked.owner?.title).toBe('Redacted');
    expect(other).toBe(rows[1]);
    expect(mediaRowMatchesWithDocs(masked, 'photo', new Set(['photo.jpg']))).toBe(false);
    expect(mediaRowMatchesWithDocs(masked, '', new Set())).toBe(true);
    expect(seenMediaRows(rows, cards, view({ showMasked: false }))).toEqual([rows[1]]);
    expect(seenMediaRows(rows, cards, view({ mask: false }))).toBe(rows);
  });
});
