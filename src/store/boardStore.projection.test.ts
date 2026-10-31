import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doc, type DocChanged } from '../platform/document';
import { boardStore } from './boardStore';
import { drafts } from '../lib/drafts';
import type { Card, Connection } from '../types/board';

vi.mock('../platform/document', () => ({
  doc: {
    moveCards: vi.fn(),
    updateCard: vi.fn(),
    refreshCard: vi.fn(),
    addCards: vi.fn(),
    deleteCards: vi.fn(),
    updateCluster: vi.fn(),
    deleteCluster: vi.fn(),
    undo: vi.fn(),
  },
}));

vi.mock('../storage', () => ({
  storage: { mediaCardDraft: vi.fn().mockResolvedValue({ notes: 'OCR text', imageMeta: null }) },
}));

const card = (id: string, x = 0) => ({ id, title: id, clusterIds: [], position: { x, y: 0 } }) as unknown as Card;
const link = { id: 'e1', source: 'a', target: 'b', kind: 'red-string' } as Connection;
const state = () => boardStore.getState();

const change = (over: Partial<DocChanged>): DocChanged => ({
  boardId: 'brd_open',
  cards: [],
  connections: [],
  clusters: [],
  removedCards: [],
  removedConnections: [],
  removedClusters: [],
  canUndo: true,
  canRedo: false,
  ...over,
});

beforeEach(() => {
  vi.mocked(doc.moveCards).mockReset().mockResolvedValue();
  vi.mocked(doc.updateCard).mockReset().mockResolvedValue();
  vi.mocked(doc.refreshCard).mockReset().mockResolvedValue();
  vi.mocked(doc.addCards).mockReset().mockResolvedValue();
  vi.mocked(doc.deleteCards).mockReset().mockResolvedValue();
  vi.mocked(doc.updateCluster).mockReset().mockResolvedValue();
  vi.mocked(doc.deleteCluster).mockReset().mockResolvedValue();
  vi.mocked(doc.undo).mockReset().mockResolvedValue();
  boardStore.setState({
    currentBoardId: 'brd_open',
    cards: [card('a'), card('b', 10)],
    connections: [link],
    clusters: [],
    selectedCardId: null,
    lastDeleted: null,
    lastError: null,
  });
});

describe('a change from the shell', () => {
  it('replaces a known row in place, appends a new one and drops a removed one', () => {
    const renamed = { ...card('b', 10), title: 'Renamed' };
    state().applyDocChanged(change({ cards: [renamed, card('c')], removedCards: ['a'], removedConnections: ['e1'] }));
    expect(state().cards.map((c) => c.title)).toEqual(['Renamed', 'c']);
    expect(state().connections).toEqual([]);
  });

  it('for another board is ignored', () => {
    const before = state().cards;
    state().applyDocChanged(change({ boardId: 'brd_other', removedCards: ['a'] }));
    expect(state().cards).toBe(before);
  });

  it('puts rows back in the order an undo gives, and carries the log flags', () => {
    state().applyDocChanged(change({ cards: [card('z')], cardOrder: ['a', 'z', 'b'], canRedo: true }));
    expect(state().cards.map((c) => c.id)).toEqual(['a', 'z', 'b']);
    expect([state().canUndo, state().canRedo]).toEqual([true, true]);
  });

  it('removing the selected card lets go of it', () => {
    boardStore.setState({ selectedCardId: 'a' });
    state().applyDocChanged(change({ removedCards: ['a'] }));
    expect(state().selectedCardId).toBeNull();
  });
});

describe('a change that changes nothing sends nothing', () => {
  it('settling a card where it already is', () => {
    state().arrangeCards(new Map([['a', { x: 0, y: 0 }]]));
    expect(doc.moveCards).not.toHaveBeenCalled();
  });

  it('committing a field with its current value', () => {
    state().updateCard('a', { title: 'a' });
    expect(doc.updateCard).not.toHaveBeenCalled();
  });
});

describe('a settled drag', () => {
  it('moves at once and sends only the moved cards, in one command', () => {
    state().arrangeCards(new Map([['a', { x: 5, y: 5 }], ['b', { x: 10, y: 0 }]]));
    expect(state().cards[0].position).toEqual({ x: 5, y: 5 });
    expect(doc.moveCards).toHaveBeenCalledExactlyOnceWith('brd_open', [{ id: 'a', position: { x: 5, y: 5 } }]);
  });

  it('moves back when the shell refuses it', async () => {
    vi.mocked(doc.moveCards).mockRejectedValue('That board isn’t open.');
    state().arrangeCards(new Map([['a', { x: 5, y: 5 }]]));
    await vi.waitFor(() => expect(state().lastError).toBe('That board isn’t open.'));
    expect(state().cards[0].position).toEqual({ x: 0, y: 0 });
  });
});

describe('undo', () => {
  const meta = { title: 'Case', updatedAt: '2026-10-31T00:00:00.000Z' };

  it('commits a pending draft before the shell undoes', () => {
    const flush = () => {
      drafts.release(flush);
      state().updateCard('a', { title: 'Typed' });
    };
    drafts.hold(flush);
    state().undo();
    expect(doc.updateCard).toHaveBeenCalledWith('brd_open', 'a', { title: 'Typed' });
    expect(vi.mocked(doc.updateCard).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(doc.undo).mock.invocationCallOrder[0],
    );
    state().undo();
    expect(doc.updateCard).toHaveBeenCalledOnce();
  });

  it('never sees a reprocess, which goes to the shell unlogged', async () => {
    boardStore.setState({ cards: [{ ...card('a'), notes: '', imageFile: 'a.png' }] });
    await state().reprocessCard('a');
    expect(doc.refreshCard).toHaveBeenCalledWith('brd_open', 'a', { imageMeta: null, notes: 'OCR text' });
    expect(doc.updateCard).not.toHaveBeenCalled();
  });

  it('is offered for a delete until another content edit lands', () => {
    state().deleteCard('a');
    expect(doc.deleteCards).toHaveBeenCalledWith('brd_open', ['a']);
    state().applyDocChanged(change({ meta, removedCards: ['a'], removedConnections: ['e1'] }));
    state().applyDocChanged(change({ viewport: { x: 1, y: 1, zoom: 1 } }));
    expect(state().lastDeleted).toEqual({ kind: 'card', id: 'a', label: 'a' });
    state().applyDocChanged(change({ meta, cards: [card('a')], connections: [link], cardOrder: ['a', 'b'] }));
    expect(state().lastDeleted).toBeNull();
    expect(state().cards.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

it('two quick edits to one cluster send only their own fields, so neither undoes the other', () => {
  boardStore.setState({ clusters: [{ id: 'g1', label: 'One', color: '#fff', visible: true }] });
  state().updateCluster('g1', { color: '#000' });
  state().updateCluster('g1', { label: 'Renamed' });
  expect(vi.mocked(doc.updateCluster).mock.calls).toEqual([
    ['brd_open', 'g1', { color: '#000' }],
    ['brd_open', 'g1', { label: 'Renamed' }],
  ]);
});
