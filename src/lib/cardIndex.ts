import type { Card } from '../types/board';

/** `derive`, run once per array, so every view reading one cards array shares the result. */
export function oncePerArray<R>(derive: (cards: readonly Card[]) => R): (cards: readonly Card[]) => R {
  const results = new WeakMap<readonly Card[], R>();
  return (cards) => {
    if (!results.has(cards)) results.set(cards, derive(cards));
    return results.get(cards)!;
  };
}

export const cardsById = oncePerArray((cards) => new Map(cards.map((c) => [c.id, c])));
