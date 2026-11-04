/** Items `[start, end)` of a run laid end to end along one axis. */
export type Span = { start: number; end: number };

/** Where each of `count` items starts, then where the run ends: `count + 1` offsets. */
export function offsetsOf(count: number, extent: (i: number) => number): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + extent(i);
  return offsets;
}

/** The first index from `lo` below `hi` where `past` holds, or `hi`; `past` must not hold and then fail. */
function firstWhere(lo: number, hi: number, past: (i: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (past(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The items that overlap `[from, to)`. */
export function itemsIn(offsets: readonly number[], from: number, to: number): Span {
  const count = Math.max(0, offsets.length - 1);
  const start = firstWhere(0, count, (i) => offsets[i + 1] > from);
  const end = firstWhere(start, count, (i) => offsets[i] >= to);
  return { start, end };
}
