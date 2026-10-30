import { describe, expect, it } from 'vitest';
import type { Card, CardKind } from '../types/board';
import { drawnCardIds, linksWithin, searchMatchIds, visibleCards } from './visibility';

const card = (id: string, kind: CardKind = 'evidence', clusterIds: string[] = []): Card => ({
  id,
  title: id,
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds,
  kind,
  occurredAt: null,
  occurredAtPrecision: 'minute',
  position: { x: 0, y: 0 },
});

const clusters = [
  { id: 'shown', label: 'Shown', color: '#000', visible: true },
  { id: 'hidden', label: 'Hidden', color: '#000', visible: false },
];
const cards = [card('alpha', 'person', ['shown']), card('beta', 'person', ['hidden']), card('mail', 'email')];

describe('drawnCardIds', () => {
  it('leaves out hidden clusters and the record', () => {
    expect([...drawnCardIds(cards, clusters)]).toEqual(['alpha']);
  });
});

describe('visibleCards', () => {
  it('keeps the record but filters by cluster and search', () => {
    expect(visibleCards(cards, clusters, '').map((c) => c.id)).toEqual(['alpha', 'mail']);
    expect(visibleCards(cards, clusters, 'ALP').map((c) => c.id)).toEqual(['alpha']);
  });
});

describe('searchMatchIds', () => {
  it('is null without a query and matches only drawn cards', () => {
    expect(searchMatchIds(cards, new Set(['alpha']), '  ')).toBeNull();
    expect([...searchMatchIds(cards, new Set(['alpha']), 'a')!]).toEqual(['alpha']);
  });
});

describe('linksWithin', () => {
  it('keeps links with both ends in the set', () => {
    const links = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ];
    expect(linksWithin(links, new Set(['a', 'b']))).toEqual([links[0]]);
  });
});
