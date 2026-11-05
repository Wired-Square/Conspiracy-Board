import { createStore } from '@wired-square/store';
import type { Card, Connection } from '../types/board';
import { isMasked, seenCards, seenConnections, type MaskView } from '../lib/mask';
import { boardStore } from './boardStore';

// View state, in memory only: Mask is on at every start (D8).
export type MaskState = MaskView & {
  setMask: (mask: boolean) => void;
  setShowMasked: (showMasked: boolean) => void;
  /** Reveal one masked card until the selection leaves it (D9). */
  unmask: (id: string) => void;
  /** Marking works masked or not; clearing skips a card that is still masked (D6). */
  mark: (ids: string[], confidential: boolean) => void;
};

export const maskStore = createStore<MaskState>((set, get) => ({
  mask: true,
  showMasked: true,
  unmaskedId: null,
  setMask: (mask) => set({ mask, unmaskedId: null }),
  setShowMasked: (showMasked) => set({ showMasked }),
  unmask: (unmaskedId) => set({ unmaskedId }),
  mark(ids, confidential) {
    const board = boardStore.getState();
    const allowed = confidential
      ? ids
      : ids.filter((id) => board.cards.some((c) => c.id === id && !isMasked(c, get())));
    if (allowed.length) board.setConfidential(allowed, confidential);
  },
}));

/** The open board as the mask lets it be seen: what every surface draws and lists. */
export const seenStore = createStore<{ cards: Card[]; connections: Connection[] }>(() => see());

function see() {
  const { cards, connections } = boardStore.getState();
  const view = maskStore.getState();
  return { cards: seenCards(cards, view), connections: seenConnections(connections, cards, view) };
}

function refresh() {
  const next = see();
  const now = seenStore.getState();
  if (next.cards !== now.cards || next.connections !== now.connections) seenStore.setState(next);
}

const unsubscribe = [
  boardStore.subscribe((s, prev) => {
    const { unmaskedId } = maskStore.getState();
    if (unmaskedId && s.selectedCardId !== unmaskedId) maskStore.setState({ unmaskedId: null });
    if (s.cards !== prev.cards || s.connections !== prev.connections) refresh();
  }),
  maskStore.subscribe(refresh),
];
import.meta.hot?.dispose(() => unsubscribe.forEach((off) => off()));
