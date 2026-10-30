import { invoke } from '@tauri-apps/api/core';
import { useBoardStore } from '../store/boardStore';
import { listenTauri } from './listen';

// The webview half of the shell's quit guard (src-tauri/src/quit.rs): a quit is
// held while a save is pending, and `quit-pending` asks for it now rather than
// after the autosave debounce.
export function startQuitGuard(): () => void {
  const unsubscribe = useBoardStore.subscribe((s, prev) => {
    if (s.savePending !== prev.savePending) void invoke('set_busy', { busy: s.savePending });
  });
  const unlisten = listenTauri('quit-pending', () => void useBoardStore.getState().flushSaves());
  return () => {
    unsubscribe();
    unlisten();
  };
}
