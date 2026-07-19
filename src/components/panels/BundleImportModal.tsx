import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useBoardStore } from '../../store/boardStore';
import { useBundleImportStore } from '../../store/bundleImportStore';
import { plural } from '../../lib/format';

/**
 * Choose which boards from a picked bundle to bring in, and what to call each. A
 * rename lets an imported board sit beside the one it is a new version of — every
 * board is adopted under a fresh id, so even the same title makes a second board,
 * not an overwrite. The bundle's media is already in the library by the time this
 * opens (read_bundle stored it); this only decides which boards to keep.
 */
export function BundleImportModal() {
  const boards = useBundleImportStore((s) => s.boards);
  const close = useBundleImportStore((s) => s.close);
  const adoptBundle = useBoardStore((s) => s.adoptBundle);

  const [rows, setRows] = useState(() =>
    boards.map((board) => ({
      board,
      name: board.meta.title || 'Untitled board',
      selected: true,
    })),
  );
  const [busy, setBusy] = useState(false);

  const setRow = (i: number, patch: Partial<{ name: string; selected: boolean }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selectedCount = rows.filter((r) => r.selected).length;

  const onImport = async () => {
    setBusy(true);
    try {
      await adoptBundle(
        rows
          .filter((r) => r.selected)
          .map((r) => ({ board: r.board, title: r.name.trim() || 'Untitled board' })),
      );
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import bundle"
      onClose={close}
      footer={
        <>
          <span className="modal__status">
            {selectedCount} of {plural(rows.length, 'board')} selected
          </span>
          <button className="link-button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || selectedCount === 0} onClick={() => void onImport()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <p className="hint">
        Each ticked board is added as a new board — rename one to keep a new version beside
        the old. Untick any you don’t want.
      </p>
      <ul className="import-offer">
        {rows.map((r, i) => (
          <li key={i}>
            <input
              type="checkbox"
              aria-label={`Import ${r.name}`}
              checked={r.selected}
              onChange={(e) => setRow(i, { selected: e.target.checked })}
            />
            <input
              className="import-offer__rename"
              value={r.name}
              placeholder="Board name"
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
          </li>
        ))}
      </ul>
    </Modal>
  );
}
