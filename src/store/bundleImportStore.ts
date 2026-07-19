import { create } from 'zustand';
import type { Board } from '../types/board';

// The boards a picked bundle carried, staged for the select/rename dialog. Not
// board content, so it lives here rather than in boardStore — the same reasoning
// as emailImportStore. The media is already in the library (read_bundle stored it);
// what remains is only the choice of which boards to adopt, and under what name.

type State = {
  open: boolean;
  boards: Board[];
  openWith: (boards: Board[]) => void;
  close: () => void;
};

export const useBundleImportStore = create<State>((set) => ({
  open: false,
  boards: [],
  openWith: (boards) => set({ open: true, boards }),
  close: () => set({ open: false, boards: [] }),
}));
