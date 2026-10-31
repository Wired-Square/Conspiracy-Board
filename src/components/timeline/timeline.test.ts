// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { setCamera, type Camera } from '../board/camera';
import type { Card } from '../../types/board';
import { TimelineDrawer } from './TimelineDrawer';

vi.mock('../../storage', () => ({ storage: { searchDocuments: vi.fn(async () => []) } }));

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

const selectCard = vi.fn();
const camera = {
  getNode: vi.fn((id: string) => (id === 'drawn' ? { x: 100, y: 200, size: { width: 40, height: 60 } } : undefined)),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 0.5 })),
  setCentre: vi.fn(async () => {}),
};

// jsdom draws nothing, so it has no scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

let host: HTMLElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  boardStore.setState({
    selectCard,
    clusters: [],
    selectedCardId: null,
    cards: [
      card('drawn', { occurredAt: '2024-01-01T00:00:00.000Z' }),
      card('mail', { kind: 'email', occurredAt: '2024-01-02T00:00:00.000Z' }),
      card('later', { kind: 'event', occurredAt: '2024-01-09T00:00:00.000Z' }),
      card('loose'),
    ],
  });
  host = document.body.appendChild(document.createElement('div'));
  setCamera(camera as unknown as Camera);
  dispose = render(() => createComponent(TimelineDrawer, {}), host);
});
afterEach(() => {
  dispose();
  setCamera(null);
  document.body.replaceChildren();
});

const chip = (id: string) => host.querySelector<HTMLButtonElement>(`[data-card-id="${id}"]`);
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

test('opens on a board with dates, and the toggle collapses it', () => {
  const toggle = host.querySelector<HTMLButtonElement>('.timeline__toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toContain('3 dated · 1 undated');
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.timeline__body')).toBeNull();
});

test('picking a drawn card selects it and centres the board on it, at zoom 0.9 or more', () => {
  chip('drawn')!.click();
  expect(selectCard).toHaveBeenCalledWith('drawn');
  expect(camera.setCentre).toHaveBeenCalledWith(120, 230, { zoom: 0.9, duration: 400 });
});

test('picking a record card selects it without moving the board', () => {
  chip('mail')!.click();
  expect(selectCard).toHaveBeenCalledWith('mail');
  expect(camera.setCentre).not.toHaveBeenCalled();
});

test('the kind filter stays open across picks and hides the kinds unticked', () => {
  button('Filter').click();
  const option = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.timeline__filter-option')].find((o) => o.textContent?.includes(label))!;
  option('Email').click();
  expect(option('Email').getAttribute('aria-checked')).toBe('false');
  expect(chip('mail')).toBeNull();
  expect(button('Filter').className).toBe('is-active');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', inline: 'center', block: 'nearest' });
  button('Reset').click();
  expect(chip('mail')).not.toBeNull();
  expect(host.querySelector('.timeline__filter-menu')).not.toBeNull();
});

test('the measure tool reads the days between two picks instead of navigating', () => {
  button('Measure').click();
  chip('drawn')!.click();
  chip('later')!.click();
  expect(selectCard).not.toHaveBeenCalled();
  expect(host.querySelector('.timeline__measure-result')?.textContent).toMatch(/^8 days/);
  expect(chip('later')!.querySelector('.timeline-item__measure-mark')?.textContent).toBe('B');
});

test('a selection elsewhere lights its chip', () => {
  boardStore.setState({ selectedCardId: 'later' });
  expect(chip('later')!.classList.contains('is-selected')).toBe(true);
  expect(chip('drawn')!.classList.contains('is-selected')).toBe(false);
});
