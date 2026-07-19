import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { storage } from '../../storage';
import { useBoardStore } from '../../store/boardStore';
import { useBundleExportStore } from '../../store/bundleExportStore';
import { plural } from '../../lib/format';
import type { BoardSummary } from '../../data/boardIndex';

/**
 * Choose what to bundle: this board, some boards, or the whole library. The chosen
 * ids go to boardStore.exportBundle, which gathers the boards and their media and
 * downloads the `.zip`. Mounted only while open (see App), so its selection resets
 * each time.
 */
export function BundleExportModal() {
  const close = useBundleExportStore((s) => s.close);
  const currentBoardId = useBoardStore((s) => s.currentBoardId);
  // The current board's live title can lead the index by an autosave, so prefer it.
  const currentTitle = useBoardStore((s) => s.meta.title);
  const exportBundle = useBoardStore((s) => s.exportBundle);

  const [summaries, setSummaries] = useState<BoardSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentBoardId ? [currentBoardId] : []),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void storage.listBoards().then(setSummaries);
  }, []);

  const rows = useMemo(
    () =>
      (summaries ?? []).map((b) => ({
        id: b.id,
        title: (b.id === currentBoardId ? currentTitle : b.title) || 'Untitled board',
      })),
    [summaries, currentBoardId, currentTitle],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));

  const onExport = async () => {
    setBusy(true);
    try {
      // Close only once a file is actually written — a cancelled save panel leaves
      // the dialog up so the selection isn't lost.
      if (await exportBundle(rows.filter((r) => selected.has(r.id)).map((r) => r.id))) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export bundle"
      onClose={close}
      footer={
        <>
          <span className="modal__status">
            {selected.size} of {plural(rows.length, 'board')} selected
          </span>
          <button className="link-button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || selected.size === 0} onClick={() => void onExport()}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <p className="hint">
        A <code>.zip</code> carrying each board and every file it references — pictures, the
        original messages, attachments and documents — so it can be imported on another Mac
        with everything intact.
      </p>

      {summaries === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint">No boards to export yet.</p>
      ) : (
        <div className="field">
          <label className="import-offer__main">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span className="import-offer__text">
              <span className="import-offer__label">Entire library</span>
              <span className="import-offer__meta">All {plural(rows.length, 'board')}</span>
            </span>
          </label>
          <ul className="import-offer">
            {rows.map((r) => (
              <li key={r.id}>
                <label className="import-offer__main">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <span className="import-offer__text">
                    <span className="import-offer__label">{r.title}</span>
                    {r.id === currentBoardId && (
                      <span className="import-offer__meta">Current board</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
