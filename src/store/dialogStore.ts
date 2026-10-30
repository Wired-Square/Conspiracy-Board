import { createStore } from 'zustand/vanilla';
import type { Board } from '../types/board';

// Which dialogs are open, held outside React so the native menu and the store can
// open one with a call rather than a callback threaded through App. Each dialog has
// its own slot, so one opening never closes another. A dialog with a subject carries
// it: the card the image editor is editing, the boards a picked bundle carried.

type Dialogs = {
  manage: boolean;
  properties: boolean;
  bundleExport: boolean;
  imageEditorCardId: string | null;
  bundleImportBoards: Board[] | null;
};

const CLOSED: Dialogs = {
  manage: false,
  properties: false,
  bundleExport: false,
  imageEditorCardId: null,
  bundleImportBoards: null,
};

export const dialogStore = createStore<Dialogs>()(() => CLOSED);

export function openDialog(open: Partial<Dialogs>): void {
  dialogStore.setState(open);
}

export function closeDialog(name: keyof Dialogs): void {
  dialogStore.setState({ [name]: CLOSED[name] });
}
