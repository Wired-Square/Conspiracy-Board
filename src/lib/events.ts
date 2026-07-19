import type { Card } from '../types/board';

// The "mark as event" relation, in one place. An event card spawned from another
// carries a back-reference to it (EventMeta.sourceCardId). The checkbox that sets it,
// the timeline that folds the source under the event's milestone, and the store action
// that creates or removes it all read the relation through these — rather than the
// `kind === 'event' && event.sourceCardId === …` predicate living in three files.

/** The event card spawned from `sourceId`, if that card is marked as an event. */
export function eventFor(cards: readonly Card[], sourceId: string): Card | undefined {
  return cards.find((c) => c.kind === 'event' && c.event?.sourceCardId === sourceId);
}

/** Every source card id folded under an event's milestone on the timeline. */
export function markedEventSourceIds(cards: readonly Card[]): Set<string> {
  return new Set(
    cards.filter((c) => c.kind === 'event' && c.event?.sourceCardId).map((c) => c.event!.sourceCardId!),
  );
}
