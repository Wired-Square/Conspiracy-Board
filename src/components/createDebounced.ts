import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';

/** `value`, but only after it has held still for `ms`: a search box's text, settled before it drives expensive work. */
export function createDebounced<T>(value: Accessor<T>, ms: number): Accessor<T> {
  const [debounced, setDebounced] = createSignal(value());
  createEffect(
    on(value, (v) => {
      const timer = setTimeout(() => setDebounced(() => v), ms);
      onCleanup(() => clearTimeout(timer));
    }, { defer: true }),
  );
  return debounced;
}
