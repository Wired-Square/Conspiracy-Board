// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { DRAFT_COMMIT_MS } from '../../lib/drafts';
import type { Cluster } from '../../types/board';
import { ClusterPanel } from './ClusterPanel';

const cluster = (id: string, over: Partial<Cluster> = {}): Cluster => ({ id, label: id, color: '#aa0000', visible: true, ...over });
const updateCluster = vi.fn((id: string, patch: Partial<Cluster>) =>
  boardStore.setState((s) => ({ clusters: s.clusters.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
);

const setClustersVisible = vi.fn((visible: boolean) =>
  boardStore.setState((s) => ({ clusters: s.clusters.map((c) => ({ ...c, visible })) })),
);

let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  boardStore.setState({ clusters: [cluster('a'), cluster('b')], updateCluster, setClustersVisible });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => ClusterPanel(), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  setClustersVisible.mockClear();
});

const showAll = () => host.querySelector<HTMLInputElement>('.cluster-show-all');

test('a renamed cluster keeps its row and focus through its own write', () => {
  vi.useFakeTimers();
  const label = host.querySelector<HTMLInputElement>('.cluster-label')!;
  label.focus();
  label.value = 'Suspects';
  label.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(DRAFT_COMMIT_MS);
  expect(updateCluster).toHaveBeenCalledWith('a', { label: 'Suspects' });
  expect(host.querySelector('.cluster-label')).toBe(label);
  expect(document.activeElement).toBe(label);
});

test('the toggle collapses the list and says so', () => {
  const toggle = host.querySelector<HTMLButtonElement>('.cluster-panel__toggle')!;
  expect(host.querySelectorAll('.cluster-row')).toHaveLength(2);
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelectorAll('.cluster-row')).toHaveLength(0);
});

test('the show-all box is checked, indeterminate or clear as all, some or none are shown', () => {
  expect([showAll()!.checked, showAll()!.indeterminate]).toEqual([true, false]);
  boardStore.setState({ clusters: [cluster('a'), cluster('b', { visible: false })] });
  expect([showAll()!.checked, showAll()!.indeterminate]).toEqual([false, true]);
  boardStore.setState({ clusters: [cluster('a', { visible: false }), cluster('b', { visible: false })] });
  expect([showAll()!.checked, showAll()!.indeterminate]).toEqual([false, false]);
});

test('the show-all box shows every cluster, or hides them all once all are shown', () => {
  boardStore.setState({ clusters: [cluster('a'), cluster('b', { visible: false })] });
  showAll()!.click();
  expect(setClustersVisible).toHaveBeenLastCalledWith(true);
  showAll()!.click();
  expect(setClustersVisible).toHaveBeenLastCalledWith(false);
  expect(setClustersVisible).toHaveBeenCalledTimes(2);
});

test('the show-all box stays while the panel is collapsed and goes with the last cluster', () => {
  host.querySelector<HTMLButtonElement>('.cluster-panel__toggle')!.click();
  expect(showAll()).not.toBeNull();
  boardStore.setState({ clusters: [] });
  expect(showAll()).toBeNull();
});
