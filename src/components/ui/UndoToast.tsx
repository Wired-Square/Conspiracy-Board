import { useEffect, useState } from 'react';
import { useBoardStore, type DeleteSnapshot } from '../../store/boardStore';

const SHOW_MS = 10_000;

/** "Deleted “The Nightingale File”", or the cluster's label for a cluster. */
function label(snap: DeleteSnapshot): string {
  const name = snap.kind === 'card' ? snap.card.title : snap.cluster.label;
  return `Deleted ${snap.kind === 'cluster' ? 'cluster ' : ''}“${name || 'Untitled'}”`;
}

/**
 * The way back from a delete: a pill beside BackgroundTaskIndicator offering
 * Undo for a few seconds after a card or cluster is deleted. Hiding is only
 * the toast giving up the space — the snapshot stays restorable (Cmd+Z, see
 * useUndoShortcut) until the next delete or a board switch clears it.
 */
export function UndoToast() {
  const snap = useBoardStore((s) => s.lastDelete);
  const undo = useBoardStore((s) => s.undoLastDelete);
  const [hidden, setHidden] = useState(false);

  // Re-show and re-arm the timer for each new snapshot; object identity is the
  // key, so deleting twice in a row keeps the toast up.
  useEffect(() => {
    if (!snap) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), SHOW_MS);
    return () => clearTimeout(t);
  }, [snap]);

  if (!snap || hidden) return null;
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>{label(snap)}</span>
      <button className="link-button" onClick={undo}>
        Undo
      </button>
    </div>
  );
}
