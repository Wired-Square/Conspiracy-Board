/** @jsxImportSource solid-js */
import { Index, createSignal } from 'solid-js';
import { count } from '@wired-square/kit/core';
import { Modal } from '../ui/Modal';
import { closeDialog } from '../../store/dialogStore';
import { boardStore } from '../../store/boardStore';
import type { Board } from '../../types/board';

/**
 * Choose which boards from a picked bundle to bring in, and what to call each. A
 * rename lets an imported board sit beside the one it is a new version of — every
 * board is adopted under a fresh id, so even the same title makes a second board,
 * not an overwrite. The bundle's media is already in the library by the time this
 * opens (read_bundle stored it); this only decides which boards to keep.
 */
export function BundleImportModal(props: { boards: Board[] }) {
  const close = () => closeDialog('bundleImportBoards');

  const [rows, setRows] = createSignal(
    props.boards.map((board) => ({
      board,
      name: board.meta.title || 'Untitled board',
      selected: true,
    })),
  );
  const [busy, setBusy] = createSignal(false);

  const setRow = (i: number, patch: Partial<{ name: string; selected: boolean }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selectedCount = () => rows().filter((r) => r.selected).length;

  const onImport = async () => {
    setBusy(true);
    try {
      await boardStore.getState().adoptBundle(
        rows()
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
          <span class="modal__status">
            {selectedCount()} of {count(rows().length, 'board')} selected
          </span>
          <button class="link-button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy() || selectedCount() === 0} onClick={() => void onImport()}>
            {busy() ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <p class="hint">
        Each ticked board is added as a new board — rename one to keep a new version beside
        the old. Untick any you don’t want.
      </p>
      <ul class="import-offer">
        <Index each={rows()}>
          {(r, i) => (
            <li>
              <input
                type="checkbox"
                aria-label={`Import ${r().name}`}
                checked={r().selected}
                onChange={(e) => setRow(i, { selected: e.currentTarget.checked })}
              />
              <input
                class="import-offer__rename"
                value={r().name}
                placeholder="Board name"
                onInput={(e) => setRow(i, { name: e.currentTarget.value })}
              />
            </li>
          )}
        </Index>
      </ul>
    </Modal>
  );
}
