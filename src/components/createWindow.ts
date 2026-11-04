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
 * Only the items in a scrolling container's viewport, plus overscan: draw `range()`,
 * with spacers of `before()` and `after()` holding the run's length. `measure` each
 * drawn item whose size can differ from its estimate.
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

  let container: HTMLElement | undefined;
  const sync = () => {
    if (!container) return;
    setView({
      scroll: horizontal ? container.scrollLeft : container.scrollTop,
      size: horizontal ? container.clientWidth : container.clientHeight,
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
          if (changed) remeasured();
        });
  const viewport = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
  onCleanup(() => {
    items?.disconnect();
    viewport?.disconnect();
  });

  return {
    range,
    before: () => offsets()[range().start],
    after: () => offsets()[offsets().length - 1] - offsets()[range().end],
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
