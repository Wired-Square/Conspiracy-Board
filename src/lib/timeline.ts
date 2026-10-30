import type { Card, CardKind, Cluster } from '../types/board';
import { hiddenClusterIds, isVisible } from './clusters';
import { dayKey, daysBetween, daysBetweenCards } from './dates';
import { markedEventSourceIds } from './events';
import { CARD_KINDS, isTimelineKind } from './kinds';
import { cardMatchesWithDocs, normaliseQuery } from './search';

export type TimelineCards = {
  /** Visible dated cards, oldest first. */
  dated: Card[];
  /** Visible cards with no date. They have no place in an ordering. */
  undated: Card[];
};

/**
 * The timeline's cards, per cluster visibility and its OWN search. The timeline
 * runs a full-text search (card fields *and* indexed file bodies), distinct from
 * the toolbar's in-memory entity search; `docHits` are the cards whose files match.
 */
export function timelineCards(
  cards: Card[],
  clusters: Cluster[],
  query: string,
  docHits: Set<string>,
): TimelineCards {
  const hidden = hiddenClusterIds(clusters);
  const q = normaliseQuery(query);
  const visible = cards.filter((c) => isVisible(c.clusterIds, hidden) && cardMatchesWithDocs(c, q, docHits));

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
  dated.sort((a, b) => a.occurredAt!.localeCompare(b.occurredAt!) || a.title.localeCompare(b.title));
  undated.sort((a, b) => a.title.localeCompare(b.title));

  return { dated, undated };
}

/** The kinds on the strip, in CARD_KINDS order, and how many of each. */
export function kindTally(...lists: Card[][]): { presentKinds: CardKind[]; kindCounts: Map<CardKind, number> } {
  const kindCounts = new Map<CardKind, number>();
  for (const list of lists) for (const c of list) kindCounts.set(c.kind, (kindCounts.get(c.kind) ?? 0) + 1);
  return { presentKinds: CARD_KINDS.filter((k) => kindCounts.has(k)), kindCounts };
}

export type DayGroup = { key: string; gapDays: number; cards: Card[] };

/** Consecutive dated cards grouped by day, each with the days since the group before. */
export function dayGroups(dated: Card[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const card of dated) {
    const key = dayKey(card.occurredAt!, card.occurredAtPrecision);
    const last = out[out.length - 1];
    if (last && last.key === key) last.cards.push(card);
    else out.push({ key, gapDays: last ? daysBetween(last.key, key) : 0, cards: [card] });
  }
  return out;
}

/** Elapsed days from one event to the next, keyed by the later event's id. */
export function eventGaps(events: Card[]): Map<string, number> {
  const gap = new Map<string, number>();
  events.forEach((e, i) => {
    if (i > 0) gap.set(e.id, daysBetweenCards(events[i - 1], e));
  });
  return gap;
}

export type EventStep = 'start' | 'prev' | 'next' | 'end';

/** Where the event controls land from `cursor`, among `count` events. */
export function stepEvent(where: EventStep, cursor: number, count: number): number {
  if (where === 'start') return 0;
  if (where === 'end') return count - 1;
  return where === 'prev' ? Math.max(0, cursor - 1) : Math.min(count - 1, cursor + 1);
}

/** The measure tool's endpoints after picking `id`: first, then second, then a third starts over. */
export function nextPicks(picks: string[], id: string): string[] {
  if (picks.length >= 2) return [id];
  return picks.includes(id) ? picks : [...picks, id];
}

export type Measurement = { from: Card; to: Card; days: number };

/**
 * The days between the two picks, ordered earliest→latest so the readout and
 * the A/B badges read in time order however the two chips were clicked.
 */
export function measureBetween(picks: string[], datedById: Map<string, Card>): Measurement | null {
  if (picks.length < 2) return null;
  const a = datedById.get(picks[0]);
  const b = datedById.get(picks[1]);
  if (!a || !b) return null;
  const [from, to] = a.occurredAt! <= b.occurredAt! ? [a, b] : [b, a];
  return { from, to, days: daysBetweenCards(from, to) };
}

/** The A/B badge on each measured chip. */
export function measureMarks(measurement: Measurement | null, picks: string[]): Map<string, 'A' | 'B'> {
  const marks = new Map<string, 'A' | 'B'>();
  if (measurement) {
    marks.set(measurement.from.id, 'A');
    marks.set(measurement.to.id, 'B');
  } else if (picks[0]) {
    marks.set(picks[0], 'A');
  }
  return marks;
}
