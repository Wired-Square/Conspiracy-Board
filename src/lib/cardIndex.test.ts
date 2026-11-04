import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../types/board';
import { cardsById, oncePerArray } from './cardIndex';
import { eventFor } from './events';
import { buildRoster, rosterOf } from './roster';

const card = (id: string, over: Partial<Card> = {}) => ({ id, title: id, kind: 'evidence', clusterIds: [], ...over }) as Card;
const event = (id: string, source: string) => card(id, { kind: 'event', event: { sourceCardId: source } });

describe('oncePerArray', () => {
  it('derives once per array and again for a new one', () => {
    const derive = vi.fn((cards: readonly Card[]) => cards.length);
    const count = oncePerArray(derive);
    const cards = [card('a')];
    expect(count(cards)).toBe(1);
    expect(count(cards)).toBe(1);
    expect(count([...cards, card('b')])).toBe(2);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('shares the roster between views of one cards array', () => {
    const cards = [card('p', { kind: 'person', person: { addresses: ['jo@x.com'] } } as Partial<Card>)];
    expect(rosterOf(cards)).toBe(rosterOf(cards));
    expect(rosterOf(cards)).toEqual(buildRoster(cards));
  });
});

describe('cardsById', () => {
  it('finds a card by id', () => {
    const cards = [card('a'), card('b')];
    expect(cardsById(cards).get('b')).toBe(cards[1]);
    expect(cardsById(cards).get('z')).toBeUndefined();
  });
});

describe('eventFor', () => {
  it('finds the first event card pointing back at a source, and only an event', () => {
    const cards = [card('src'), card('not-event', { event: { sourceCardId: 'src' } }), event('e1', 'src'), event('e2', 'src')];
    expect(eventFor(cards, 'src')?.id).toBe('e1');
    expect(eventFor(cards, 'e1')).toBeUndefined();
  });
});
