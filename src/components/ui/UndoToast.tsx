import { useEffect, useState } from 'react';
import { type Deleted } from '../../store/boardStore';
import { useBoardStore } from '../../hooks/useStores';

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
  const deleted = useBoardStore((s) => s.lastDeleted);
  const undo = useBoardStore((s) => s.undo);
  const [hidden, setHidden] = useState(false);

  // Re-show and re-arm the timer for each delete; object identity is the key, so
  // deleting twice in a row keeps the toast up.
  useEffect(() => {
    if (!deleted) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), SHOW_MS);
    return () => clearTimeout(t);
  }, [deleted]);

  if (!deleted || hidden) return null;
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>{label(deleted)}</span>
      <button className="link-button" onClick={undo}>
        Undo
      </button>
    </div>
  );
}
