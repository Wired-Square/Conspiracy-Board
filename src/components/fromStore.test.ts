import { describe, expect, it } from 'vitest';
import { createEffect, createRoot } from 'solid-js';
import { createStore } from 'zustand/vanilla';
import { fromStore } from './fromStore';

const counterStore = () => createStore<{ count: number; label: string }>()(() => ({ count: 0, label: 'a' }));

// Effects queued inside createRoot's body only run once it returns, so the
// store is driven after the root is set up.
function track<T>(read: () => T) {
  const seen: T[] = [];
  createRoot(() => createEffect(() => seen.push(read())));
  return seen;
}

describe('fromStore', () => {
  it('reads the selected slice and follows store changes', () => {
    const store = counterStore();
    const count = createRoot(() => fromStore(store, (s) => s.count));
    expect(count()).toBe(0);
    store.setState({ count: 2 });
    expect(count()).toBe(2);
  });

  it('notifies dependants only when the selected slice changes', () => {
    const store = counterStore();
    const count = createRoot(() => fromStore(store, (s) => s.count));
    const seen = track(count);
    store.setState({ label: 'b' });
    store.setState({ count: 1 });
    store.setState({ count: 1 });
    expect(seen).toEqual([0, 1]);
  });

  it('uses the given equality to suppress structurally equal selections', () => {
    const store = counterStore();
    const pair = createRoot(() =>
      fromStore(
        store,
        (s) => [s.count, s.label.length] as const,
        (a, b) => a[0] === b[0] && a[1] === b[1],
      ),
    );
    const seen = track(() => pair()[0]);
    store.setState({ label: 'c' });
    store.setState({ count: 3 });
    expect(seen).toEqual([0, 3]);
  });

  it('keeps a function-valued selection rather than calling it as an updater', () => {
    const store = createStore<{ act: () => string }>()(() => ({ act: () => 'first' }));
    const act = createRoot(() => fromStore(store, (s) => s.act));
    store.setState({ act: () => 'second' });
    expect(act()()).toBe('second');
  });

  it('unsubscribes when its owner is disposed', () => {
    const store = counterStore();
    const [count, dispose] = createRoot((dispose) => [fromStore(store, (s) => s.count), dispose] as const);
    dispose();
    store.setState({ count: 5 });
    expect(count()).toBe(0);
  });
});
