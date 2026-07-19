import { create } from 'zustand';

// Whether the Manage dialog is open. A standalone flag — like usePropertiesStore
// — so the native File menu can open it with a setState from outside React,
// keeping the menu action headless. Rename, Delete and Reveal live inside the
// dialog now rather than as three separate File-menu items.
export const useManageStore = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
);
