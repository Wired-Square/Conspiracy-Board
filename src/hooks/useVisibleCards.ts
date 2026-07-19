import { useMemo } from 'react';
import type { Card } from '../types/board';
import { useBoardStore } from '../store/boardStore';
import { hiddenClusterIds, isVisible } from '../lib/clusters';
import { cardMatchesEntity, normaliseQuery } from '../lib/search';

/**
 * Canonical cards the record can currently see, per cluster visibility and the
 * toolbar's in-memory entity search — names, email addresses, phone numbers,
 * domains (see cardMatchesEntity). The board dims rather than drops, so it matches
 * the query itself (see BoardCanvas); the timeline has its own full-text search and
 * no longer reads through here.
 */
export function useVisibleCards(): Card[] {
  const cards = useBoardStore((s) => s.cards);
  const clusters = useBoardStore((s) => s.clusters);
  const searchQuery = useBoardStore((s) => s.searchQuery);

  return useMemo(() => {
    const hidden = hiddenClusterIds(clusters);
    const q = normaliseQuery(searchQuery);
    return cards.filter((c) => isVisible(c.clusterId, hidden) && cardMatchesEntity(c, q));
  }, [cards, clusters, searchQuery]);
}
