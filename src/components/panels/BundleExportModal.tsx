import { For, Show, Switch, Match, createMemo, createSignal } from 'solid-js';
import type { BoardSummary } from '../../storage/StorageAdapter';
import { count } from '@wired-square/kit/core';
import { Modal } from '../ui/Modal';
import { storage } from '../../storage';
import { closeDialog } from '../../store/dialogStore';
import { boardStore } from '../../store/boardStore';
import { fromStore } from '../fromStore';

/**
 * Choose what to bundle: this board, some boards, or the whole library. The chosen
 * ids go to boardStore.exportBundle, which gathers the boards and their media and
 * downloads the `.zip`. Mounted only while open (see App), so its selection resets
 * each time.
 */
export function BundleExportModal() {
  const close = () => closeDialog('bundleExport');
  const currentBoardId = fromStore(boardStore, (s) => s.currentBoardId);
  const currentTitle = fromStore(boardStore, (s) => s.meta.title);

  const [summaries, setSummaries] = createSignal<BoardSummary[] | null>(null);
  void storage.listBoards().then(setSummaries);
  const initialId = currentBoardId();
  const [selected, setSelected] = createSignal<Set<string>>(new Set(initialId ? [initialId] : []));
  const [busy, setBusy] = createSignal(false);

  const rows = createMemo(() =>
    (summaries() ?? []).map((b) => ({
      id: b.id,
      title: (b.id === currentBoardId() ? currentTitle() : b.title) || 'Untitled board',
    })),
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = () => rows().length > 0 && rows().every((r) => selected().has(r.id));
  const toggleAll = () => setSelected(allSelected() ? new Set<string>() : new Set(rows().map((r) => r.id)));

  const onExport = async () => {
    setBusy(true);
    try {
      // Close only once a file is actually written — a cancelled save panel leaves
      // the dialog up so the selection isn't lost.
      const ids = rows().filter((r) => selected().has(r.id)).map((r) => r.id);
      if (await boardStore.getState().exportBundle(ids)) close();
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
          <span class="modal__status">
            {selected().size} of {count(rows().length, 'board')} selected
          </span>
          <button class="link-button" onClick={close}>
            Cancel
          </button>
          <button disabled={busy() || selected().size === 0} onClick={() => void onExport()}>
            {busy() ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <p class="hint">
        A <code>.zip</code> carrying each board and every file it references — pictures, the
        original messages, attachments and documents — so it can be imported on another Mac
        with everything intact.
      </p>

      <Switch>
        <Match when={summaries() === null}>
          <p class="hint">Loading…</p>
        </Match>
        <Match when={rows().length === 0}>
          <p class="hint">No boards to export yet.</p>
        </Match>
        <Match when={true}>
          <div class="field">
            <label class="import-offer__main">
              <input type="checkbox" checked={allSelected()} onChange={toggleAll} />
              <span class="import-offer__text">
                <span class="import-offer__label">Entire library</span>
                <span class="import-offer__meta">All {count(rows().length, 'board')}</span>
              </span>
            </label>
            <ul class="import-offer">
              <For each={rows()}>
                {(r) => (
                  <li>
                    <label class="import-offer__main">
                      <input type="checkbox" checked={selected().has(r.id)} onChange={() => toggle(r.id)} />
                      <span class="import-offer__text">
                        <span class="import-offer__label">{r.title}</span>
                        <Show when={r.id === currentBoardId()}>
                          <span class="import-offer__meta">Current board</span>
                        </Show>
                      </span>
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Match>
      </Switch>
    </Modal>
  );
}
