import { create } from 'zustand';

// Just the open flag for the export scope dialog, mirroring propertiesStore /
// imageEditorStore. The dialog reads the board list from storage and drives
// boardStore.exportBundle itself; nothing about the choice needs to live here.

type State = {
  open: boolean;
  openDialog: () => void;
  close: () => void;
};

export const useBundleExportStore = create<State>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}));
