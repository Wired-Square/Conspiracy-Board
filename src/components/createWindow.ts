import { createMemo, createSignal, onCleanup } from 'solid-js';
import { itemsIn, offsetsOf, type Span } from '../lib/windowing';

type Options = {
  count: () => number;
  /** What an item is known by, so its measured size follows it when items before it change. */
  key: (i: number) => string;
  /** Its size along the axis until it has been drawn and measured. */
  estimate: (i: number) => number;
  axis: 'x' | 'y';
  /** How far past each edge of the viewport items are drawn, in px. */
  overscan: number;
};

/** A viewport not yet laid out (or under jsdom, which lays nothing out) is taken to be this long. */
const UNMEASURED_VIEWPORT = 2000;

/**
 * Only the items in a scrolling container's viewport, plus overscan: draw `drawn()`,
 * with spacers of `before()` and `after()` holding the run's length, and `skipped(key)`
 * as a margin before an item that follows a run left out. `measure` each drawn item
 * whose size can differ from its estimate; `pin` an item (the focused one) to keep it
 * drawn wherever the view goes.
 */
export function createWindow(o: Options) {
  const horizontal = o.axis === 'x';
  const [view, setView] = createSignal(
    { scroll: 0, size: 0 },
    { equals: (a, b) => a.scroll === b.scroll && a.size === b.size },
  );
  const sizes = new Map<string, number>();
  const [measured, remeasured] = createSignal(undefined, { equals: false });
  const offsets = createMemo(() => {
    measured();
    return offsetsOf(o.count(), (i) => sizes.get(o.key(i)) ?? o.estimate(i));
  });
  const range = createMemo<Span>(
    () => {
      const { scroll, size } = view();
      return itemsIn(offsets(), scroll - o.overscan, scroll + (size || UNMEASURED_VIEWPORT) + o.overscan);
    },
    { start: 0, end: 0 },
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );
  const [pinned, pin] = createSignal<string | null>(null);
  const pinnedIndex = createMemo(() => {
    const key = pinned();
    if (key === null) return -1;
    for (let i = 0; i < o.count(); i++) if (o.key(i) === key) return i;
    return -1;
  });
  const drawn = createMemo(() => {
    const { start, end } = range();
    const indices = Array.from({ length: end - start }, (_, k) => start + k);
    const p = pinnedIndex();
    if (p < 0 || (p >= start && p < end)) return indices;
    return p < start ? [p, ...indices] : [...indices, p];
  });

  let container: HTMLElement | undefined;
  const sync = () => {
    if (!container) return;
    setView({
      scroll: horizontal ? container.scrollLeft : container.scrollTop,
      size: horizontal ? container.clientWidth : container.clientHeight,
    });
  };

  // Drawing what a measurement changes inside the observer's callback starts new
  // observations it can't deliver that frame, which WebKit reports as a loop error.
  let frame = 0;
  const pending = { remeasure: false, sync: false };
  const nextFrame = (what: keyof typeof pending) => {
    pending[what] = true;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (pending.sync) sync();
      if (pending.remeasure) remeasured();
      pending.sync = pending.remeasure = false;
    });
  };

  const keyOf = new WeakMap<Element, string>();
  const items =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          let changed = false;
          for (const entry of entries) {
            const key = keyOf.get(entry.target);
            const box = entry.borderBoxSize?.[0];
            const size = box ? (horizontal ? box.inlineSize : box.blockSize) : 0;
            if (key === undefined || size === 0 || sizes.get(key) === size) continue;
            sizes.set(key, size);
            changed = true;
          }
          if (changed) nextFrame('remeasure');
        });
  const viewport = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => nextFrame('sync'));
  onCleanup(() => {
    items?.disconnect();
    viewport?.disconnect();
    cancelAnimationFrame(frame);
  });

  const jump = createMemo(() => {
    const at = drawn().findIndex((i, k) => k > 0 && i !== drawn()[k - 1] + 1);
    if (at < 0) return null;
    const i = drawn()[at];
    return { key: o.key(i), px: offsets()[i] - offsets()[drawn()[at - 1] + 1] };
  });
  const first = () => drawn()[0] ?? range().start;
  const last = () => drawn().at(-1) ?? range().end - 1;

  return {
    drawn,
    before: () => offsets()[first()],
    after: () => offsets()[offsets().length - 1] - offsets()[last() + 1],
    /** The run left out just before the drawn item with this key, in px, or 0. */
    skipped: (key: string) => (jump()?.key === key ? jump()!.px : 0),
    pin,
    pinned,
    /** The scrolling element's ref. */
    container(el: HTMLElement) {
      container = el;
      el.addEventListener('scroll', sync, { passive: true });
      viewport?.observe(el);
      onCleanup(() => viewport?.unobserve(el));
      sync();
    },
    /** A drawn item's ref, with its key. */
    measure(el: HTMLElement, key: string) {
      keyOf.set(el, key);
      items?.observe(el);
      onCleanup(() => items?.unobserve(el));
    },
    /** Scroll just far enough to show item `i` whole, and draw it now. */
    reveal(i: number) {
      if (!container) return;
      const at = offsets();
      const size = horizontal ? container.clientWidth : container.clientHeight;
      const scroll = horizontal ? container.scrollLeft : container.scrollTop;
      const to = Math.min(Math.max(scroll, at[i + 1] - size), at[i]);
      if (horizontal) container.scrollLeft = to;
      else container.scrollTop = to;
      sync();
    },
    /** Centre item `i` in the viewport and draw it now, before the scroll event lands. */
    centre(i: number) {
      if (!container) return;
      const at = offsets();
      const size = horizontal ? container.clientWidth : container.clientHeight;
      const to = Math.max(0, (at[i] + at[i + 1]) / 2 - size / 2);
      if (horizontal) container.scrollLeft = to;
      else container.scrollTop = to;
      sync();
    },
    sync,
  };
}
