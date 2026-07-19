import { create } from 'zustand';

// Which card the image dialog is editing, or null when it is closed. A standalone
// flag like usePropertiesStore / useEmailImportStore, so the CardEditor opens it
// with a setState rather than being threaded a callback — and, being about one
// card, it carries that card's id rather than a bare boolean.
export const useImageEditorStore = create<{
  cardId: string | null;
  openFor: (cardId: string) => void;
  close: () => void;
}>((set) => ({
  cardId: null,
  openFor: (cardId) => set({ cardId }),
  close: () => set({ cardId: null }),
}));
