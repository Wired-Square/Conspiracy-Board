import { invoke } from '@tauri-apps/api/core';
import { boardStore, type BoardState } from '../store/boardStore';
import { openDialog } from '../store/dialogStore';
import { storage } from '../storage';
import { prompt } from '../store/promptStore';
import type { View } from '../types/view';
import { listenTauri } from './listen';

// The webview half of the native File and View menus (built in
// src-tauri/src/menu.rs). It keeps the menu's board list and view checkmark in
// step with the store, and turns a menu click — delivered as `menu:board` or
// `menu:view` — into a store call, with the reusable prompt dialog standing in for
// the text input a native menu can't host.

type BoardMenuEvent = { action: string; id: string | null };
type ViewMenuEvent = { view: View };

/** Rebuild the native menu from the current library and view. */
async function syncMenu() {
  const { currentBoardId, meta, view } = boardStore.getState();
  const summaries = await storage.listBoards();
  // The index lags a rename by the 500ms autosave, and the current board is the
  // only one renamable from the menu — so show its live title straight away.
  const boards = summaries.map((b) => ({
    id: b.id,
    title: b.id === currentBoardId ? meta.title : b.title,
  }));
  await invoke('set_board_menu', { boards, currentId: currentBoardId, view });
}

async function handle(event: BoardMenuEvent) {
  const store = boardStore.getState();
  switch (event.action) {
    case 'new': {
      const name = await prompt({
        title: 'New board',
        label: 'Name',
        placeholder: 'Untitled board',
        confirmLabel: 'Create',
      });
      if (name) await store.newBoard(name);
      break;
    }
    case 'open':
      if (event.id) await store.openBoard(event.id);
      break;
    case 'manage':
      // Rename, Delete and Show in Finder live inside this dialog now.
      openDialog({ manage: true });
      break;
    case 'import':
      await store.importBoard();
      break;
    case 'export':
      openDialog({ bundleExport: true });
      break;
    case 'properties':
      openDialog({ properties: true });
      break;
  }
}

// The board list, its titles, the checkmark and the current view are a pure
// function of these fields — every mutation moves one (new/open/import/delete
// move currentBoardId; rename moves meta.title; the dropdown moves view) — so
// watching them re-syncs the menu after any change, and on first load when the
// list arrives. (Recency *order* can lag an unrelated edit until the next
// switch/rename; the contents are always right.)
const menuChanged = (s: BoardState, prev: BoardState) =>
  s.currentBoardId !== prev.currentBoardId || s.meta.title !== prev.meta.title || s.view !== prev.view;

/** Drive the native menus: dispatch their clicks, keep them in sync. */
export function startBoardMenu(): () => void {
  // One rebuild per burst: opening a board moves several of the fields at once.
  let queued = false;
  const requestSync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void syncMenu();
    });
  };

  const offBoard = listenTauri<BoardMenuEvent>('menu:board', (e) => void handle(e.payload));
  // A View-menu click switches the surface. Only re-sync by hand when it re-picks
  // the surface already showing — the OS unticks the item on click but `view`
  // doesn't change, so the subscription below wouldn't put the tick back. A real
  // switch leaves it to the subscription, so the menu rebuilds once.
  const offView = listenTauri<ViewMenuEvent>('menu:view', (e) => {
    const changed = boardStore.getState().view !== e.payload.view;
    boardStore.getState().setView(e.payload.view);
    if (!changed) void syncMenu();
  });
  const unsubscribe = boardStore.subscribe((s, prev) => {
    if (menuChanged(s, prev)) requestSync();
  });
  requestSync();

  return () => {
    offBoard();
    offView();
    unsubscribe();
  };
}
