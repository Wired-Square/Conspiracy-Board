// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import type { Card } from '../../types/board';
import { RecordView } from './RecordView';

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: [],
  position: { x: 0, y: 0 },
  kind: 'document',
  occurredAt: null,
  occurredAtPrecision: 'day',
  ...over,
});

const selectCard = vi.fn((id: string | null) => boardStore.setState({ selectedCardId: id }));
let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  boardStore.setState({
    selectCard,
    clusters: [],
    connections: [{ id: 'k', source: 'linked', target: 'p', label: undefined } as never],
    searchQuery: '',
    selectedCardId: null,
    cards: [card('linked'), card('stray'), card('p', { kind: 'person' }), card('pin', { kind: 'evidence' })],
  });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => RecordView(), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

const titles = () => [...host.querySelectorAll('.record-row__title')].map((t) => t.textContent);
const row = (title: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.record-row')].find((r) => r.title === title)!;

test('lists the record kinds only, and narrows to what is loose', () => {
  expect(titles().sort()).toEqual(['linked', 'stray']);
  expect(host.querySelector('.record__count')?.textContent).toBe('2 items · 1 not linked up');
  const filter = host.querySelector<HTMLInputElement>('.record__filter input')!;
  filter.click();
  expect(titles()).toEqual(['stray']);
});

test('a click selects the row, and a row survives an edit to another card', () => {
  const stray = row('stray');
  row('linked').click();
  expect(selectCard).toHaveBeenCalledWith('linked');
  expect(row('linked').classList.contains('is-selected')).toBe(true);
  boardStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === 'linked' ? { ...c, title: 'renamed' } : c)) }));
  expect(row('stray')).toBe(stray);
});

test('a hidden cluster hides its rows', () => {
  boardStore.setState((s) => ({
    clusters: [{ id: 'c', label: 'c', color: '#000000', visible: false }],
    cards: s.cards.map((c) => (c.id === 'stray' ? { ...c, clusterIds: ['c'] } : c)),
  }));
  expect(titles()).toEqual(['linked']);
});
