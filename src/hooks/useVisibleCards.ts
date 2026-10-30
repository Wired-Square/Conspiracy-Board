import { useMemo } from 'react';
import type { Card } from '../types/board';
import { visibleCards } from '../lib/visibility';
import { useBoardStore } from './useStores';

/** The record's cards; see visibleCards. The timeline has its own search (useTimelineCards). */
export function useVisibleCards(): Card[] {
  const cards = useBoardStore((s) => s.cards);
  const clusters = useBoardStore((s) => s.clusters);
  const searchQuery = useBoardStore((s) => s.searchQuery);
  return useMemo(() => visibleCards(cards, clusters, searchQuery), [cards, clusters, searchQuery]);
}
