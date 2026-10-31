import { boardStore } from '../store/boardStore';

type Keyed = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>;

/** Whether the key event happened inside something that has its own undo. */
function inEditable(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
}

/** Cmd+Z is board undo and Shift+Cmd+Z board redo, except in a text field, which keeps its own. */
export function boardUndoKey(e: Keyed): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z' || inEditable(e.target)) return null;
  return e.shiftKey ? 'redo' : 'undo';
}

/**
 * The keyboard's route to the shell's undo log. Best-effort on macOS: the native
 * Edit menu's Undo item may take the shortcut before the webview sees it, so the
 * toast's button is the path that always works.
 */
export function startUndoShortcut(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const step = boardUndoKey(e);
    if (!step) return;
    e.preventDefault();
    boardStore.getState()[step]();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
