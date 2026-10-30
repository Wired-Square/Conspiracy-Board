import { useMemo } from 'react';
import { timelineCards, type TimelineCards } from '../lib/timeline';
import { useBoardStore } from './useStores';

/** The timeline's cards for its own search; `query` + `docHits` come from the drawer (see useDocHits). */
export function useTimelineCards(query: string, docHits: Set<string>): TimelineCards {
  const cards = useBoardStore((s) => s.cards);
  const clusters = useBoardStore((s) => s.clusters);
  return useMemo(() => timelineCards(cards, clusters, query, docHits), [cards, clusters, query, docHits]);
}
