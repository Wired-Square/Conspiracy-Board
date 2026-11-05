import { beforeEach, expect, it, vi } from 'vitest';
import { doc } from '../platform/document';
import { boardStore } from './boardStore';
import { maskStore, seenStore } from './maskStore';
import type { Card } from '../types/board';

vi.mock('../platform/document', () => ({ doc: { setConfidential: vi.fn() } }));
vi.mock('../storage', () => ({ storage: {} }));

const card = (id: string, confidential = false) =>
  ({ id, title: id, clusterIds: [], kind: 'evidence', position: { x: 0, y: 0 }, confidential }) as Partial<Card> as Card;

beforeEach(() => {
  vi.mocked(doc.setConfidential).mockReset().mockResolvedValue();
  maskStore.setState({ mask: true, showMasked: true, unmaskedId: null });
  boardStore.setState({
    currentBoardId: 'brd',
    selectedCardId: null,
    cards: [card('open'), card('secret', true)],
    connections: [{ id: 'l', source: 'open', target: 'secret', kind: 'red-string' }],
  });
});

const titles = () => seenStore.getState().cards.map((c) => c.title);

it('starts masked, showing masked items, and nothing unmasked', () => {
  const { mask, showMasked, unmaskedId } = maskStore.getState();
  expect({ mask, showMasked, unmaskedId }).toEqual({ mask: true, showMasked: true, unmaskedId: null });
});

it('the seen board follows the controls and the document', () => {
  expect(titles()).toEqual(['open', 'Redacted']);
  maskStore.getState().setShowMasked(false);
  expect(titles()).toEqual(['open']);
  expect(seenStore.getState().connections).toEqual([]);
  maskStore.getState().setMask(false);
  expect(titles()).toEqual(['open', 'secret']);
  boardStore.setState({ cards: [card('open', true)] });
  expect(titles()).toEqual(['open']);
});

it('an unmasked card masks again when the selection leaves it, or the editor closes', () => {
  const { selectCard } = boardStore.getState();
  selectCard('secret');
  maskStore.getState().unmask('secret');
  expect(titles()).toEqual(['open', 'secret']);
  boardStore.setState({ cards: [...boardStore.getState().cards] });
  expect(titles()).toEqual(['open', 'secret']);
  selectCard('open');
  expect(titles()).toEqual(['open', 'Redacted']);

  selectCard('secret');
  maskStore.getState().unmask('secret');
  selectCard(null);
  expect(maskStore.getState().unmaskedId).toBeNull();
  expect(titles()).toEqual(['open', 'Redacted']);
});

it('turning Mask back on forgets the unmasked card', () => {
  boardStore.getState().selectCard('secret');
  maskStore.getState().unmask('secret');
  maskStore.getState().setMask(false);
  maskStore.getState().setMask(true);
  expect(titles()).toEqual(['open', 'Redacted']);
});

it('marks masked or not, but clears only a card that is not masked (D6)', () => {
  const { mark } = maskStore.getState();
  mark(['open'], true);
  expect(doc.setConfidential).toHaveBeenLastCalledWith('brd', ['open'], true);

  mark(['secret'], false);
  expect(doc.setConfidential).toHaveBeenCalledOnce();

  boardStore.getState().selectCard('secret');
  maskStore.getState().unmask('secret');
  mark(['secret'], false);
  expect(doc.setConfidential).toHaveBeenLastCalledWith('brd', ['secret'], false);

  maskStore.getState().setMask(false);
  boardStore.setState({ cards: [card('open', true), card('secret', true)] });
  mark(['open', 'secret'], false);
  expect(doc.setConfidential).toHaveBeenLastCalledWith('brd', ['open', 'secret'], false);
});
