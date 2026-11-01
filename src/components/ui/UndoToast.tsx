import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { boardStore, type Deleted } from '../../store/boardStore';
import { fromStore } from '@wired-square/store/solid';

const SHOW_MS = 10_000;

/** "Deleted “The Nightingale File”", or the cluster's label for a cluster. */
function label(deleted: Deleted): string {
  return `Deleted ${deleted.kind === 'cluster' ? 'cluster ' : ''}“${deleted.label || 'Untitled'}”`;
}

/**
 * The way back from a delete: a pill beside BackgroundTaskIndicator offering
 * Undo for a few seconds after a card or cluster is deleted, while that delete is
 * still the last edit. Cmd+Z (see startUndoShortcut) undoes it either way.
 */
export function UndoToast() {
  const deleted = fromStore(boardStore, (s) => s.lastDeleted);
  const [hidden, setHidden] = createSignal(false);

  // Re-show and re-arm the timer for each delete; object identity is the key, so
  // deleting twice in a row keeps the toast up.
  createEffect(() => {
    if (!deleted()) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), SHOW_MS);
    onCleanup(() => clearTimeout(t));
  });

  return (
    <Show when={!hidden() && deleted()}>
      {(shown) => (
        <div class="undo-toast" role="status" aria-live="polite">
          <span>{label(shown())}</span>
          <button class="link-button" onClick={() => boardStore.getState().undo()}>
            Undo
          </button>
        </div>
      )}
    </Show>
  );
}
