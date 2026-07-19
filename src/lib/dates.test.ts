import { describe, expect, it } from 'vitest';
import type { Card } from '../types/board';
import {
  changePrecision,
  dayKey,
  daysBetween,
  daysBetweenCards,
  formatOccurredAt,
  fromLocalInputValue,
  toLocalInputValue,
} from './dates';

// These run under TZ=America/Los_Angeles (see the "test" script). That matters:
// day-precision instants are stored at UTC midnight, so every assertion below
// passes trivially in a UTC-ish zone and catches real off-by-one-day bugs in a
// UTC-negative one. `pnpm test:utc` runs the same suite at UTC.

describe('day precision', () => {
  it('stores a picked date at UTC midnight', () => {
    expect(fromLocalInputValue('2024-11-14', 'day')).toBe('2024-11-14T00:00:00.000Z');
  });

  it('round-trips a picked date back into the input unchanged', () => {
    const iso = fromLocalInputValue('2024-11-14', 'day')!;
    expect(toLocalInputValue(iso, 'day')).toBe('2024-11-14');
  });

  it('renders the stored day, not the local day', () => {
    // The bug this guards: UTC midnight rendered in local time reads as the 13th
    // for anyone west of Greenwich.
    const iso = fromLocalInputValue('2024-11-14', 'day')!;
    expect(formatOccurredAt(iso, 'day')).toContain('14');
    expect(formatOccurredAt(iso, 'day')).not.toContain('13');
  });

  it('groups under the same day it prints', () => {
    const iso = fromLocalInputValue('2024-11-14', 'day')!;
    expect(dayKey(iso, 'day')).toBe('2024-11-14');
  });
});

describe('minute precision', () => {
  it('round-trips a local datetime through storage', () => {
    const iso = fromLocalInputValue('2024-11-14T17:32', 'minute')!;
    // Stored as UTC…
    expect(iso.endsWith('Z')).toBe(true);
    // …but the input must show the local time the user typed.
    expect(toLocalInputValue(iso, 'minute')).toBe('2024-11-14T17:32');
  });

  it('groups under the local day', () => {
    const iso = fromLocalInputValue('2024-11-14T17:32', 'minute')!;
    expect(dayKey(iso, 'minute')).toBe('2024-11-14');
  });

  it('groups a late-evening local time under that local day', () => {
    // 23:30 in Los Angeles is already the next day in UTC. The chip must still
    // file under the 14th, matching what it prints.
    const iso = fromLocalInputValue('2024-11-14T23:30', 'minute')!;
    expect(dayKey(iso, 'minute')).toBe('2024-11-14');
  });

  it('rejects an empty or unparseable value', () => {
    expect(fromLocalInputValue('', 'minute')).toBeNull();
    expect(fromLocalInputValue('not-a-date', 'minute')).toBeNull();
  });
});

describe('changePrecision', () => {
  it('minute → day keeps the calendar day the user saw', () => {
    const iso = fromLocalInputValue('2024-11-14T23:30', 'minute')!;
    expect(changePrecision(iso, 'day')).toBe('2024-11-14T00:00:00.000Z');
  });

  it('day → minute stays on the same day rather than jumping backwards', () => {
    // Reusing the raw UTC-midnight instant would render as 16:00 on the 13th
    // in Los Angeles.
    const iso = fromLocalInputValue('2024-11-14', 'day')!;
    const next = changePrecision(iso, 'minute');
    expect(toLocalInputValue(next, 'minute')).toBe('2024-11-14T09:00');
  });
});

describe('daysBetween', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween('2024-11-01', '2024-11-06')).toBe(5);
  });

  it('is unaffected by daylight saving transitions', () => {
    // US DST ends 3 Nov 2024; a naive local-time subtraction would give 30.958…
    expect(daysBetween('2024-10-20', '2024-11-20')).toBe(31);
  });
});

describe('daysBetweenCards', () => {
  const dated = (iso: string, occurredAtPrecision: Card['occurredAtPrecision']): Card =>
    ({ occurredAt: iso, occurredAtPrecision }) as Card;

  it('is the absolute gap, so pick order does not matter', () => {
    const a = dated(fromLocalInputValue('2024-11-01', 'day')!, 'day');
    const b = dated(fromLocalInputValue('2024-11-06', 'day')!, 'day');
    expect(daysBetweenCards(a, b)).toBe(5);
    expect(daysBetweenCards(b, a)).toBe(5);
  });

  it('reckons by calendar day, so two times on one day are zero apart', () => {
    const morning = dated(fromLocalInputValue('2024-11-14T09:00', 'minute')!, 'minute');
    const evening = dated(fromLocalInputValue('2024-11-14T21:30', 'minute')!, 'minute');
    expect(daysBetweenCards(morning, evening)).toBe(0);
  });

  it('measures across mixed precisions on the day each card files under', () => {
    const day = dated(fromLocalInputValue('2024-11-14', 'day')!, 'day');
    const minute = dated(fromLocalInputValue('2024-11-20T17:32', 'minute')!, 'minute');
    expect(daysBetweenCards(day, minute)).toBe(6);
  });
});
