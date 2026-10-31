import { createMemo, createSignal, type Accessor } from 'solid-js';

/** A field's local text, re-seeded from `seed` whenever what it reads changes — typed into freely, committed by the caller. */
export function createSeeded<T>(seed: Accessor<T>): [Accessor<T>, (next: T) => void] {
  const signal = createMemo(() => createSignal(seed()));
  return [() => signal()[0](), (next) => signal()[1](() => next)];
}
