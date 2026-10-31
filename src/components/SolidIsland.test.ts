// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRenderEffect, onCleanup } from 'solid-js';
import { SolidIsland } from './SolidIsland';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

function mountIsland(props: Record<string, unknown>) {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const rerender = (next: Record<string, unknown>) =>
    act(() => root!.render(createElement(SolidIsland<Record<string, unknown>>, { component: Probe, ...next })));
  rerender(props);
  return { host, rerender };
}

let mounts = 0;
let cleanups = 0;
function Probe(props: { label?: string; onPick?: () => string }) {
  mounts++;
  onCleanup(() => cleanups++);
  const el = document.createElement('span');
  createRenderEffect(() => (el.textContent = `${props.label}:${props.onPick?.()}`));
  return el;
}

test('a prop change from React reaches the Solid tree in place', () => {
  mounts = cleanups = 0;
  const { host, rerender } = mountIsland({ label: 'one', onPick: () => 'a' });
  expect(host.textContent).toBe('one:a');

  rerender({ label: 'two', onPick: () => 'b' });
  expect(host.textContent).toBe('two:b');
  expect(mounts).toBe(1);

  rerender({ onPick: () => 'c' });
  expect(host.textContent).toBe('undefined:c');
});

test('unmounting the island disposes the Solid tree', () => {
  mounts = cleanups = 0;
  const { host } = mountIsland({ label: 'x' });
  act(() => root!.unmount());
  root = undefined;
  expect(cleanups).toBe(1);
  expect(host.textContent).toBe('');
});
