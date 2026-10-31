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

let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  boardStore.setState({ clusters: [cluster('a'), cluster('b')], updateCluster });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => ClusterPanel(), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

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
