import { createSignal, onCleanup, type Accessor } from 'solid-js';
import type { StoreApi } from 'zustand/vanilla';

export function fromStore<S, T>(
  store: StoreApi<S>,
  selector: (state: S) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): Accessor<T> {
  const [value, setValue] = createSignal(selector(store.getState()), { equals });
  onCleanup(store.subscribe((state) => setValue(() => selector(state))));
  return value;
}
