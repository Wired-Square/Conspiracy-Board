import { useMemo } from 'react';
import type { Card } from '../types/board';
import { isTimelineKind } from '../lib/kinds';
import { markedEventSourceIds } from '../lib/events';
import { useBoardStore } from '../store/boardStore';
import { hiddenClusterIds, isVisible } from '../lib/clusters';
import { cardMatchesWithDocs, normaliseQuery } from '../lib/search';

export type TimelineCards = {
  /** Visible dated cards, oldest first. */
  dated: Card[];
  /** Visible cards with no date. They have no place in an ordering. */
  undated: Card[];
};

/**
 * The timeline's cards, per cluster visibility and its OWN search. The timeline
 * runs a full-text search (card fields *and* indexed file bodies), distinct from
 * the toolbar's in-memory entity search, so it filters here rather than through
 * `useVisibleCards`. `query` + `docHits` come from the drawer (see useDocHits).
 */
export function useTimelineCards(query: string, docHits: Set<string>): TimelineCards {
  const cards = useBoardStore((s) => s.cards);
  const clusters = useBoardStore((s) => s.clusters);

  return useMemo(() => {
    const hidden = hiddenClusterIds(clusters);
    const q = normaliseQuery(query);
    const visible = cards.filter(
      (c) => isVisible(c.clusterIds, hidden) && cardMatchesWithDocs(c, q, docHits),
    );

    const dated: Card[] = [];
    const undated: Card[] = [];
    // A card marked as an event has an event card pointing back at it; the event
    // carries the same moment. Show the event's milestone and fold the source under
    // it, so the two don't list twice at the same instant. Only when the event is
    // itself visible, so a search that hides the event never hides its source.
    const foldedSources = markedEventSourceIds(visible);
    // Actors are left out entirely — a person is not a moment. By kind rather
    // than by having no date: they would otherwise pile into the undated column
    // and bury what is genuinely undated there.
    for (const c of visible) {
      if (!isTimelineKind(c.kind) || foldedSources.has(c.id)) continue;
      (c.occurredAt ? dated : undated).push(c);
    }

    // Every occurredAt is a normalised UTC ISO instant, so lexicographic order
    // is chronological order — no Date allocation per comparison.
    dated.sort(
      (a, b) => a.occurredAt!.localeCompare(b.occurredAt!) || a.title.localeCompare(b.title),
    );
    undated.sort((a, b) => a.title.localeCompare(b.title));

    return { dated, undated };
  }, [cards, clusters, query, docHits]);
}
