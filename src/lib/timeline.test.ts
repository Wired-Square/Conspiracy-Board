import { describe, expect, it } from 'vitest';
import type { Card, CardKind } from '../types/board';
import {
  dayGroups,
  eventGaps,
  kindTally,
  measureBetween,
  measureMarks,
  nextPicks,
  stepEvent,
  timelineCards,
} from './timeline';

const card = (id: string, day: string | null, kind: CardKind = 'evidence', over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: [],
  kind,
  occurredAt: day ? `${day}T12:00:00.000Z` : null,
  occurredAtPrecision: 'day',
  position: { x: 0, y: 0 },
  ...over,
});

describe('timelineCards', () => {
  it('sorts the dated, keeps the undated apart and leaves actors and hidden clusters out', () => {
    const hiddenCluster = { id: 'k', label: 'K', color: '#000', visible: false };
    const cards = [
      card('late', '2024-03-02'),
      card('early', '2024-03-01'),
      card('loose', null),
      card('who', '2024-03-01', 'person'),
      card('gone', '2024-03-01', 'evidence', { clusterIds: ['k'] }),
    ];
    const { dated, undated } = timelineCards(cards, [hiddenCluster], '', new Set());
    expect(dated.map((c) => c.id)).toEqual(['early', 'late']);
    expect(undated.map((c) => c.id)).toEqual(['loose']);
  });

  it('folds a marked source under its event', () => {
    const source = card('src', '2024-03-01');
    const event = card('ev', '2024-03-01', 'event', { event: { sourceCardId: 'src' } });
    expect(timelineCards([source, event], [], '', new Set()).dated.map((c) => c.id)).toEqual(['ev']);
  });
});

describe('kindTally', () => {
  it('counts kinds across lists in CARD_KINDS order', () => {
    const { presentKinds, kindCounts } = kindTally([card('a', null, 'event'), card('b', null)], [card('c', null)]);
    expect(presentKinds).toEqual(['event', 'evidence']);
    expect(kindCounts.get('evidence')).toBe(2);
  });
});

describe('dayGroups', () => {
  it('groups by day and counts the days between groups', () => {
    const groups = dayGroups([card('a', '2024-03-01'), card('b', '2024-03-01'), card('c', '2024-03-05')]);
    expect(groups.map((g) => [g.key, g.gapDays, g.cards.length])).toEqual([
      ['2024-03-01', 0, 2],
      ['2024-03-05', 4, 1],
    ]);
  });
});

describe('eventGaps', () => {
  it('keys each gap by the later event', () => {
    const gaps = eventGaps([card('a', '2024-03-01', 'event'), card('b', '2024-03-11', 'event')]);
    expect([...gaps]).toEqual([['b', 10]]);
  });
});

describe('stepEvent', () => {
  it('clamps prev and next to the ends', () => {
    expect(stepEvent('prev', 0, 3)).toBe(0);
    expect(stepEvent('next', 2, 3)).toBe(2);
    expect(stepEvent('next', 0, 3)).toBe(1);
    expect(stepEvent('end', 0, 3)).toBe(2);
    expect(stepEvent('start', 2, 3)).toBe(0);
  });
});

describe('measuring', () => {
  const a = card('a', '2024-03-10');
  const b = card('b', '2024-03-01');
  const byId = new Map([a, b].map((c) => [c.id, c]));

  it('picks first, then second, then starts over', () => {
    expect(nextPicks([], 'a')).toEqual(['a']);
    expect(nextPicks(['a'], 'a')).toEqual(['a']);
    expect(nextPicks(['a'], 'b')).toEqual(['a', 'b']);
    expect(nextPicks(['a', 'b'], 'c')).toEqual(['c']);
  });

  it('reads earliest to latest however the chips were clicked', () => {
    const m = measureBetween(['a', 'b'], byId);
    expect(m).toEqual({ from: b, to: a, days: 9 });
    expect([...measureMarks(m, ['a', 'b'])]).toEqual([
      ['b', 'A'],
      ['a', 'B'],
    ]);
  });

  it('marks a lone first pick', () => {
    expect(measureBetween(['a'], byId)).toBeNull();
    expect([...measureMarks(null, ['a'])]).toEqual([['a', 'A']]);
  });
});
