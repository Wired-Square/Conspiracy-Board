import type { Card, Cluster } from '../types/board';
import { hiddenClusterIds, isVisible } from './clusters';
import { isBoardKind } from './kinds';
import { cardMatchesEntity, normaliseQuery } from './search';

/**
 * Cards the record can currently see, per cluster visibility and the toolbar's
 * in-memory entity search — names, email addresses, phone numbers, domains (see
 * cardMatchesEntity). The board dims rather than drops, so it matches the query
 * itself (see searchMatchIds).
 */
export function visibleCards(cards: Card[], clusters: Cluster[], searchQuery: string): Card[] {
  const hidden = hiddenClusterIds(clusters);
  const q = normaliseQuery(searchQuery);
  return cards.filter((c) => isVisible(c.clusterIds, hidden) && cardMatchesEntity(c, q));
}

/**
 * The cards the board draws. Two reasons a card is not drawn: every cluster it
 * is in is hidden, or it is the record and belongs in the Record view.
 */
export function drawnCardIds(cards: Card[], clusters: Cluster[]): Set<string> {
  const hidden = hiddenClusterIds(clusters);
  return new Set(cards.filter((c) => isVisible(c.clusterIds, hidden) && isBoardKind(c.kind)).map((c) => c.id));
}

/**
 * The drawn cards the search matches — null when nothing is being searched,
 * which the highlight pass reads as "don't dim by search".
 */
export function searchMatchIds(cards: Card[], drawn: Set<string>, searchQuery: string): Set<string> | null {
  const q = normaliseQuery(searchQuery);
  if (!q) return null;
  return new Set(cards.filter((c) => drawn.has(c.id) && cardMatchesEntity(c, q)).map((c) => c.id));
}

/** The links with both ends among `ids`. */
export function linksWithin<T extends { source: string; target: string }>(links: T[], ids: Set<string>): T[] {
  return links.filter((l) => ids.has(l.source) && ids.has(l.target));
}
