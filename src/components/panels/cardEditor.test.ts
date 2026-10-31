// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { boardStore } from '../../store/boardStore';
import { dialogStore } from '../../store/dialogStore';
import { DRAFT_COMMIT_MS } from '../../lib/drafts';
import { GRADE_META } from '../../lib/grades';
import type { Card, Connection, EmailAddress } from '../../types/board';
import { CardEditor } from './CardEditor';

vi.mock('../../storage', () => ({ storage: { openMedia: vi.fn(async () => {}) } }));

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

const actions = {
  updateCard: vi.fn(),
  updateConnection: vi.fn(),
  addConnection: vi.fn(),
  addCard: vi.fn(),
  setView: vi.fn(),
  selectCard: vi.fn((id: string | null) => boardStore.setState({ selectedCardId: id })),
};

let host: HTMLElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  Object.values(actions).forEach((a) => a.mockClear());
  boardStore.setState({ ...actions, cards: [], connections: [], clusters: [], selectedCardId: null });
  host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => CardEditor(), host);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  dialogStore.setState({ imageEditorCardId: null });
  vi.useRealTimers();
});

const open = (cards: Card[], selected = cards[0].id, connections: Connection[] = []) =>
  boardStore.setState({ cards, connections, selectedCardId: selected });
const replaceCard = (next: Card) =>
  boardStore.setState((s) => ({ cards: s.cards.map((c) => (c.id === next.id ? next : c)) }));
const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const field = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('.field')].find((f) => f.firstElementChild?.textContent === label)!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const choose = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

test('the editor opens on the selection and closes on Escape', () => {
  expect(host.querySelector('.modal')).toBeNull();
  open([card('a', { kind: 'document' })]);
  expect(field('Title').querySelector('input')!.value).toBe('a');
  expect(field('Kind').querySelector('select')!.value).toBe('document');
  escape();
  expect(actions.selectCard).toHaveBeenCalledWith(null);
  expect(host.querySelector('.modal')).toBeNull();
});

test('the title commits when typing pauses, and to its own card when the selection moves', () => {
  vi.useFakeTimers();
  open([card('a'), card('b')]);
  type(field('Title').querySelector('input')!, 'Renamed');
  vi.advanceTimersByTime(DRAFT_COMMIT_MS - 1);
  expect(actions.updateCard).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(actions.updateCard).toHaveBeenCalledWith('a', { title: 'Renamed' });

  type(field('Title').querySelector('input')!, 'Half typed');
  boardStore.setState({ selectedCardId: 'b' });
  expect(actions.updateCard).toHaveBeenLastCalledWith('a', { title: 'Half typed' });
  expect(field('Title').querySelector('input')!.value).toBe('b');
});

test('the notes preview renders the draft as markdown', () => {
  open([card('a')]);
  expect(field('Preview')).toBeUndefined();
  type(field('Notes (markdown)').querySelector('textarea')!, '**bold** <i>raw</i>');
  const preview = field('Preview').querySelector('.markdown')!;
  expect(preview.querySelector('strong')?.textContent).toBe('bold');
  expect(preview.querySelector('i')).toBeNull();
});

test('the grade picker shows the chosen grade’s definition', () => {
  open([card('a')]);
  const grade = field('Grade');
  expect(grade.querySelector('.field__hint')!.textContent).toContain('Nobody has graded this yet');
  choose(grade.querySelector('select')!, 'admitted');
  expect(actions.updateCard).toHaveBeenCalledWith('a', { grade: 'admitted' });
  replaceCard(card('a', { grade: 'admitted' }));
  expect(grade.querySelector('select')!.value).toBe('admitted');
  expect(grade.querySelector('.field__hint')!.textContent).toBe(GRADE_META.admitted.definition);
});

test('the connection picker stacks over the editor, and Escape closes only the top', () => {
  open([card('a'), card('b', { kind: 'person', title: 'Bea' })]);
  button('Link to a card').click();
  expect(host.querySelectorAll('.modal')).toHaveLength(2);
  escape();
  expect(host.querySelectorAll('.modal')).toHaveLength(1);
  expect(actions.selectCard).not.toHaveBeenCalled();

  button('Link to a card').click();
  button('Bea').click();
  expect(actions.addConnection).toHaveBeenCalledWith('a', 'b');
  expect(host.querySelectorAll('.modal')).toHaveLength(1);
});

test('a connection row keeps its half-typed label when a write replaces the row', () => {
  const string: Connection = { id: 'e1', source: 'a', target: 'b', kind: 'red-string' } as Connection;
  open([card('a'), card('b')], 'a', [string]);
  const label = host.querySelector<HTMLInputElement>('.connection-label')!;
  label.value = 'owns';
  boardStore.setState({ connections: [{ ...string, grade: 'admitted' }] });
  expect(host.querySelector('.connection-label')).toBe(label);
  expect(label.value).toBe('owns');
  label.dispatchEvent(new Event('blur'));
  expect(actions.updateConnection).toHaveBeenCalledWith('e1', { label: 'owns' });
});

test('an imported email from Mail offers Open in Mail, and links a sender as a new person', () => {
  open([
    card('a', {
      kind: 'email',
      email: {
        from: { name: 'Jane', address: 'jane@acme.example' },
        to: [],
        cc: [],
        attachments: [],
        source: 'mail-drag',
        messageId: '<m1@acme.example>',
      } as unknown as Card['email'],
    }),
  ]);
  expect(host.querySelector('.email-fields__mail-link')?.getAttribute('href')).toBe('message:%3Cm1@acme.example%3E');
  button('Link…').click();
  button('New person').click();
  expect(actions.addCard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'person' }));
});

test('a message’s From commits on blur and shows a rewrite from elsewhere', () => {
  const message = (from: EmailAddress | null) =>
    card('a', { kind: 'message', message: { from, to: [], body: '' } as unknown as Card['message'] });
  open([message(null)]);
  const from = field('Message details').querySelector('input')!;
  type(from, 'Jane <0400 123 456>');
  expect(actions.updateCard).not.toHaveBeenCalled();
  from.dispatchEvent(new Event('blur'));
  expect(actions.updateCard).toHaveBeenCalledWith('a', {
    message: expect.objectContaining({ from: expect.objectContaining({ name: 'Jane' }) }),
  });
  replaceCard(message({ name: 'Bob', address: '+61400999888' }));
  expect(from.value).toBe('Bob <+61400999888>');
});

test('the picture link opens the image editor for this card', () => {
  open([card('a')]);
  button('Add image…').click();
  expect(dialogStore.getState().imageEditorCardId).toBe('a');
});
