// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { maskStore } from '../../store/maskStore';
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

const many = (n: number) => ({
  cards: [card('p', { kind: 'person' }), ...Array.from({ length: n }, (_, i) => card(`d${i}`))],
  connections: Array.from({ length: n / 2 }, (_, i) => ({ id: `k${i}`, source: `d${i * 2}`, target: 'p' }) as never),
});

test('a long record draws only the rows in view, and the loose filter and selection still apply', () => {
  boardStore.setState(many(500));
  const drawn = host.querySelectorAll('.record-row').length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(100);
  expect(host.querySelector('.record__count')?.textContent).toBe('500 items · 250 not linked up');
  const [, after] = [...host.querySelectorAll<HTMLElement>('.record__spacer')].map((s) => parseFloat(s.style.height));
  expect(after).toBeGreaterThan(400 * 50);

  host.querySelector<HTMLInputElement>('.record__filter input')!.click();
  expect([...host.querySelectorAll('.record-row')].every((r) => r.classList.contains('is-loose'))).toBe(true);
  const first = host.querySelector<HTMLButtonElement>('.record-row')!;
  first.click();
  expect(selectCard).toHaveBeenCalledWith(first.title);
  expect(host.querySelector('.record-row')!.classList.contains('is-selected')).toBe(true);
});

test('leaving the record and coming back keeps its scroll position', () => {
  const scrolled = new WeakMap<Element, number>();
  const real = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return scrolled.get(this) ?? 0;
    },
    set(v: number) {
      scrolled.set(this, v);
    },
  });
  try {
    boardStore.setState({ ...many(500), currentBoardId: 'b1' });
    dispose();
    dispose = render(() => RecordView(), host);
    host.querySelector('.record__list')!.scrollTop = 6000;
    dispose();
    dispose = render(() => RecordView(), host);
    expect(host.querySelector('.record__list')!.scrollTop).toBe(6000);
    expect(host.querySelector<HTMLButtonElement>('.record-row')!.title).not.toBe('d0');
  } finally {
    Object.defineProperty(Element.prototype, 'scrollTop', real);
  }
});

test('Tab and Shift+Tab walk every row in order, drawing the next and keeping the focused one', () => {
  const scrolled = new WeakMap<Element, number>();
  const real = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return scrolled.get(this) ?? 0;
    },
    set(v: number) {
      scrolled.set(this, v);
    },
  });
  try {
    boardStore.setState(many(500));
    const list = host.querySelector<HTMLElement>('.record__list')!;
    const focused = () => document.activeElement as HTMLButtonElement;
    const press = (shiftKey: boolean) =>
      focused().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
    const drawnBefore = host.querySelectorAll('.record-row').length;
    host.querySelector<HTMLButtonElement>('.record-row')!.focus();

    const walked = [focused().title];
    for (let i = 0; i < 150; i++) {
      press(false);
      walked.push(focused().title);
    }
    expect(new Set(walked).size).toBe(151);
    expect(walked.length).toBeGreaterThan(drawnBefore);
    expect(list.scrollTop).toBeGreaterThan(100 * 50);

    const held = focused();
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
    expect(held.isConnected).toBe(true);
    expect(focused()).toBe(held);

    for (let i = 0; i < 150; i++) press(true);
    expect(focused().title).toBe(walked[0]);
    expect(press(true)).toBe(true);
  } finally {
    Object.defineProperty(Element.prototype, 'scrollTop', real);
  }
});

test('a measurement is applied on the next frame, not inside the observer callback', () => {
  const observers: ResizeObserverCallback[] = [];
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  try {
    dispose();
    boardStore.setState(many(500));
    dispose = render(() => RecordView(), host);
    const after = () => host.querySelectorAll<HTMLElement>('.record__spacer')[1].style.height;
    const before = after();
    const rows = [...host.querySelectorAll('.record__list > li:not(.record__spacer)')];
    const grown = rows.map((target) => ({ target, borderBoxSize: [{ blockSize: 200, inlineSize: 0 }] }));
    for (const callback of observers) callback(grown as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    expect(after()).toBe(before);
    frames.splice(0).forEach((frame) => frame(0));
    expect(after()).not.toBe(before);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a masked row reads Redacted, drops out of a search, and goes when masked items are hidden', () => {
  boardStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === 'stray' ? { ...c, confidential: true } : c)) }));
  expect(titles().sort()).toEqual(['Redacted', 'linked']);
  boardStore.setState({ searchQuery: 'red' });
  expect(titles()).toEqual([]);
  boardStore.setState({ searchQuery: '' });
  maskStore.getState().setShowMasked(false);
  expect(titles()).toEqual(['linked']);
  maskStore.getState().setMask(false);
  expect(titles().sort()).toEqual(['linked', 'stray']);
  maskStore.setState({ mask: true, showMasked: true });
});
