import { create } from 'zustand';

// Whether the Board Properties modal is open. A standalone flag — like
// useEmailImportStore — so the native File menu can open it with a setState from
// outside React, which keeps every menu action headless rather than making
// Properties the one that has to be threaded through App as a callback.
export const usePropertiesStore = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
);
