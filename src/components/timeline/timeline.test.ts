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
    [...host.querySelectorAll<HTMLButtonElement>('[role=menuitemcheckbox]')].find((o) => o.textContent?.includes(label))!;
  option('Email').click();
  expect(option('Email').getAttribute('aria-checked')).toBe('false');
  expect(chip('mail')).toBeNull();
  expect(host.querySelector('.timeline__filter')!.classList.contains('is-active')).toBe(true);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', inline: 'center', block: 'nearest' });
  button('Reset').click();
  expect(chip('mail')).not.toBeNull();
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

const daily = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    card(`mail-${i}`, { kind: 'email', occurredAt: new Date(Date.UTC(2020, 0, 1 + i)).toISOString() }),
  );

test('a long strip draws only the days in view, holding the rest as spacers', () => {
  boardStore.setState({ cards: daily(400) });
  const drawn = host.querySelectorAll('.timeline-item').length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(40);
  const [before, after] = [...host.querySelectorAll<HTMLElement>('.timeline__spacer')].map((s) => parseFloat(s.style.width));
  expect(before).toBe(0);
  expect(after).toBeGreaterThan(300 * 150);
});

test('the event controls draw and centre a chip that was out of view', async () => {
  boardStore.setState({ cards: [...daily(400), card('finale', { kind: 'event', occurredAt: '2021-06-01T00:00:00.000Z' })] });
  expect(chip('finale')).toBeNull();
  const strip = host.querySelector<HTMLElement>('.timeline__strip')!;
  let scrolled = 0;
  Object.defineProperty(strip, 'scrollLeft', { get: () => scrolled, set: (v: number) => (scrolled = v) });
  button('End').click();
  await new Promise((r) => setTimeout(r, 100));
  expect(scrolled).toBeGreaterThan(300 * 150);
  expect(chip('finale')).not.toBeNull();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'nearest' });
});

const tick = () => new Promise((r) => setTimeout(r));

test('a chip the strip placed stays the anchor through a kind filter and back, though another is nearer the centre', async () => {
  boardStore.setState({
    cards: [
      ...daily(40),
      card('earlier', { kind: 'event', occurredAt: '2020-02-25T00:00:00.000Z' }),
      card('finale', { kind: 'event', occurredAt: '2020-03-01T00:00:00.000Z' }),
    ],
  });
  // At the strip's end the placed chip sits right of centre, and another is at it.
  const at: Record<string, number> = { earlier: 450, finale: 900 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = (this as HTMLElement).dataset.cardId;
    const left = id ? (at[id] ?? 2000) : 0;
    return { left, right: left + 100 } as DOMRect;
  });
  const strip = host.querySelector<HTMLElement>('.timeline__strip')!;
  let scrolled = 0;
  Object.defineProperty(strip, 'scrollLeft', { get: () => scrolled, set: (v: number) => (scrolled = v) });
  Object.defineProperty(strip, 'clientWidth', { value: 1000 });
  button('End').click();
  await new Promise((r) => setTimeout(r, 100));
  const revealed = () => (vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1) as HTMLElement).dataset.cardId;
  expect(revealed()).toBe('finale');

  button('Filter').click();
  const email = () =>
    [...host.querySelectorAll<HTMLButtonElement>('[role=menuitemcheckbox]')].find((o) => o.textContent?.includes('Email'))!;
  email().click();
  await tick();
  expect(host.querySelector('.timeline__count')!.textContent).toBe('2 dated');
  expect(revealed()).toBe('finale');
  email().click();
  await tick();
  expect(host.querySelector('.timeline__count')!.textContent).toBe('42 dated');
  expect(revealed()).toBe('finale');

  strip.dispatchEvent(new Event('wheel'));
  email().click();
  await tick();
  expect(revealed()).toBe('earlier');
  vi.restoreAllMocks();
});

test('a masked chip keeps its date and glyph but reads Redacted', () => {
  boardStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === 'mail' ? { ...c, confidential: true } : c)) }));
  expect(chip('mail')!.textContent).toContain('Redacted');
  expect(chip('mail')!.textContent).not.toContain('mail');
  expect(chip('mail')!.querySelector('.timeline-item__when')).not.toBeNull();
  expect(chip('mail')!.querySelector('.timeline-item__glyph')).not.toBeNull();
});
