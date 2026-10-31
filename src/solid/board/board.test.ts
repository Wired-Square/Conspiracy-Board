// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import type { Card, Connection } from '../../types/board';
import { BoardCanvas } from './BoardCanvas';
import { camera } from './camera';

vi.mock('../../storage', () => ({ storage: {} }));

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
  kind: 'evidence',
  occurredAt: null,
  occurredAtPrecision: 'day',
  ...over,
});
const tie: Connection = { id: 'c1', source: 'ann', target: 'memo', kind: 'red-string', label: 'wrote' };

beforeAll(() => {
  // jsdom lays nothing out and observes no sizes.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
});

const actions = { selectCard: vi.fn(), setViewport: vi.fn(), arrangeCards: vi.fn(), addConnection: vi.fn() };
let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  Object.values(actions).forEach((a) => a.mockClear());
  boardStore.setState({
    ...actions,
    viewport: { x: 0, y: 0, zoom: 1 },
    clusters: [],
    selectedCardId: null,
    searchQuery: '',
    connections: [tie],
    cards: [
      card('ann', { kind: 'person', title: 'Ann', person: { addresses: ['ann@example.com'] }, position: { x: 0, y: 0 } }),
      card('memo', { position: { x: 400, y: 0 } }),
      card('loner', { position: { x: 0, y: 400 } }),
      card('mail', { kind: 'email' }),
    ],
  });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(BoardCanvas, {}), host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

const node = (id: string) => host.querySelector<HTMLElement>(`.app-canvas__node[data-id="${id}"]`);

test('draws the board kinds only, at the saved viewport, and publishes the camera', () => {
  expect([...host.querySelectorAll<HTMLElement>('.app-canvas__node')].map((n) => n.dataset.id).sort()).toEqual([
    'ann',
    'loner',
    'memo',
  ]);
  expect(node('ann')!.querySelector('.evidence-card--polaroid .polaroid__detail')!.textContent).toBe('ann@example.com');
  expect(camera()!.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
});

test('draws the red string with its knots and tag', () => {
  expect(host.querySelectorAll('.app-canvas__edge .red-string__strand')).toHaveLength(1);
  expect(host.querySelectorAll('.app-canvas__edge .red-string__knot')).toHaveLength(2);
  expect(host.querySelector('.red-string__tag')!.textContent).toBe('wrote');
});

test('selection outlines the card, lights its neighbours and dims the rest', () => {
  boardStore.setState({ selectedCardId: 'ann' });
  expect(node('ann')!.querySelector('.is-selected')).not.toBeNull();
  expect(node('memo')!.className).toContain('hl');
  expect(node('loner')!.className).toContain('dim');
  expect(host.querySelector('.app-canvas__edge')!.getAttribute('class')).toContain('hl');
  boardStore.setState({ selectedCardId: null });
  expect(node('loner')!.className).not.toContain('dim');
});

test('hover focuses without selecting', () => {
  node('loner')!.dispatchEvent(new Event('pointerenter'));
  expect(node('ann')!.className).toContain('dim');
  expect(node('loner')!.querySelector('.is-selected')).toBeNull();
  node('loner')!.dispatchEvent(new Event('pointerleave'));
  expect(node('ann')!.className).not.toContain('dim');
});

test('an actor grows with its ties', () => {
  expect(node('ann')!.querySelector<HTMLElement>('.evidence-card')!.style.getPropertyValue('--card-scale')).not.toBe('');
  expect(node('memo')!.querySelector<HTMLElement>('.evidence-card')!.style.getPropertyValue('--card-scale')).toBe('');
});

test('fitWhenDrawn waits for the ids to be drawn, then fits', () => {
  camera()!.fitWhenDrawn({ ids: ['far'] });
  expect(camera()!.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  boardStore.setState({ cards: [...boardStore.getState().cards, card('far', { position: { x: 5000, y: 5000 } })] });
  expect(camera()!.getViewport()).not.toEqual({ x: 0, y: 0, zoom: 1 });
});

test('the search lens frames the matches, and clearing the box goes back', async () => {
  const home = { x: 0, y: 0, zoom: 1 };
  boardStore.setState({ searchQuery: 'ann' });
  await vi.waitFor(() => expect(camera()!.getViewport()).not.toEqual(home));
  boardStore.setState({ searchQuery: '' });
  await vi.waitFor(() => expect(camera()!.getViewport()).toEqual(home));
});

const pointer = (target: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 });
  target.dispatchEvent(Object.assign(event, { pointerId: 1 }));
};

test('a click selects, a pane click deselects, and a drag commits only when it settles', () => {
  const memo = node('memo')!.querySelector('.evidence-card')!;
  pointer(memo, 'pointerdown', 450, 50);
  pointer(memo, 'pointerup', 450, 50);
  expect(actions.selectCard).toHaveBeenCalledWith('memo');
  pointer(host.querySelector('.app-canvas')!, 'pointerdown', 900, 700);
  pointer(host.querySelector('.app-canvas')!, 'pointerup', 900, 700);
  expect(actions.selectCard).toHaveBeenLastCalledWith(null);

  pointer(memo, 'pointerdown', 450, 50);
  pointer(memo, 'pointermove', 500, 80);
  pointer(memo, 'pointermove', 550, 100);
  expect(actions.arrangeCards).not.toHaveBeenCalled();
  pointer(memo, 'pointerup', 550, 100);
  expect(actions.arrangeCards).toHaveBeenCalledExactlyOnceWith(new Map([['memo', { x: 500, y: 50 }]]));
});

test('a link starts from the source nub and lands anywhere on the target card', () => {
  pointer(node('loner')!.querySelector('.canvas-source')!, 'pointerdown', 200, 410);
  pointer(document.body, 'pointermove', 300, 200);
  pointer(document.body, 'pointerup', 450, 100);
  expect(actions.addConnection).toHaveBeenCalledWith('loner', 'memo');
});
