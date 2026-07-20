import { useEffect } from 'react';
import { useBoardStore } from '../store/boardStore';

/** Whether the key event happened inside something that has its own undo. */
function inEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

/**
 * Cmd+Z (or Ctrl+Z) restores the last delete — the keyboard's route to what the
 * UndoToast offers. Text fields keep their own undo: with one focused, the
 * event is left alone. Best-effort on macOS: the native Edit menu's Undo item
 * may take the shortcut before the webview sees it, so the toast's button is
 * the path that always works.
 */
export function useUndoShortcut() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== 'z') return;
      if (inEditable(e.target)) return;
      if (!useBoardStore.getState().lastDelete) return;
      e.preventDefault();
      useBoardStore.getState().undoLastDelete();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
