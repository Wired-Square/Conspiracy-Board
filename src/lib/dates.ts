import type { Card, DatePrecision } from '../types/board';

// Cards store `occurredAt` as a UTC ISO instant. Precision is a separate field
// rather than an encoding trick, so the stored string is always the same shape
// and lexicographic order stays chronological.
//
// The rule that keeps day-precision honest: a 'day' value is stored at UTC
// midnight and must be *read back in UTC* everywhere. Render UTC midnight in
// local time and everyone west of Greenwich sees the previous day.

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Newest first, undated last, then by title so equal dates do not shuffle.
 *
 * A plain string compare, and allowed to be: `occurredAt` is always a normalised
 * UTC ISO instant, which is exactly what the rule above buys — no Date to
 * allocate per comparison, on a list an mbox can make hundreds long.
 */
export function newestFirst(a: Card, b: Card): number {
  return (
    (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '') ||
    a.title.localeCompare(b.title)
  );
}

/** Local YYYY-MM-DD. The one place local-day formatting is spelled out. */
const localDayString = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Constructing an Intl formatter resolves locale data and is ~70x the cost of
// formatting with one, so they are built once rather than per card face, per
// chip and per day heading.
const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
});
const MINUTE_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const DAY_HEADING_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'full',
  timeZone: 'UTC',
});

/** Human-readable date for a card face, timeline chip or preview row. */
export function formatOccurredAt(iso: string, precision: DatePrecision): string {
  const d = new Date(iso);
  return precision === 'day' ? DAY_FMT.format(d) : MINUTE_FMT.format(d);
}

/**
 * Stable key for grouping cards under a day heading. Must resolve in the same
 * zone as formatOccurredAt, or a chip files under a heading that contradicts
 * the date printed on the chip itself.
 */
export function dayKey(iso: string, precision: DatePrecision): string {
  if (precision === 'day') return iso.slice(0, 10);
  // 'en-CA' formats as YYYY-MM-DD, which sorts correctly and reads back cleanly.
  return new Date(iso).toLocaleDateString('en-CA');
}

/** Heading text for a day group, from a `dayKey` value. */
export function formatDayKey(key: string): string {
  return DAY_HEADING_FMT.format(new Date(`${key}T00:00:00Z`));
}

/** Whole days between two dayKeys, for the timeline's gap markers. */
export function daysBetween(aKey: string, bKey: string): number {
  const a = Date.parse(`${aKey}T00:00:00Z`);
  const b = Date.parse(`${bKey}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whole days between two dated cards, by the same day-based reckoning as the
 * timeline's gap markers (so the event-gap badges and the measure tool agree with
 * the strip). Absolute — callers order the pair for display; both cards must be
 * dated.
 */
export function daysBetweenCards(a: Card, b: Card): number {
  return Math.abs(
    daysBetween(
      dayKey(a.occurredAt!, a.occurredAtPrecision),
      dayKey(b.occurredAt!, b.occurredAtPrecision),
    ),
  );
}

/** Value for a native <input type="date"|"datetime-local">. */
export function toLocalInputValue(iso: string, precision: DatePrecision): string {
  if (precision === 'day') return iso.slice(0, 10);
  // Must be built from *local* getters. `toISOString().slice(0,16)` is UTC and
  // would shift the field for anyone not on UTC.
  const d = new Date(iso);
  return `${localDayString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Read a native date/datetime-local input back into a stored UTC instant. */
export function fromLocalInputValue(
  value: string,
  precision: DatePrecision,
): string | null {
  if (!value) return null;
  // The trailing Z is load-bearing: without it this parses as local midnight.
  const d = new Date(precision === 'day' ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Re-encode an instant when the user changes a card's precision. */
export function changePrecision(
  iso: string,
  next: DatePrecision,
): string {
  const d = new Date(iso);
  if (next === 'day') {
    // Keep the day the user currently sees (local), then store it at UTC midnight.
    return `${localDayString(d)}T00:00:00.000Z`;
  }
  // Seed a sensible local working hour on the same calendar day rather than
  // reusing the raw UTC-midnight instant, which would read as the day before
  // for anyone west of Greenwich.
  const dayStr = d.toISOString().slice(0, 10);
  const [y, m, day] = dayStr.split('-').map(Number);
  return new Date(y, m - 1, day, 9, 0, 0, 0).toISOString();
}

/** A default instant for a card being dated for the first time. */
export function defaultOccurredAt(precision: DatePrecision): string {
  const now = new Date();
  if (precision === 'day') {
    return `${localDayString(now)}T00:00:00.000Z`;
  }
  now.setSeconds(0, 0);
  return now.toISOString();
}
