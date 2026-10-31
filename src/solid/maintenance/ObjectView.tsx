/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import { size, count } from '@wired-square/kit/core';
import { storage } from '../../storage';
import { mediaSrc } from '../../storage/media';
import { isDocumentFile, isImageFile } from '../../lib/fileTypes';
import { countIssues, isIssue, mediaRowMatchesWithDocs, STATUS_LABEL, type MediaRow } from '../../lib/maintenance';
import { normaliseQuery } from '../../lib/search';
import { mediaIconFor } from '../../lib/mediaIcon';
import { boardStore } from '../../store/boardStore';
import { jobsStore } from '../../store/jobsStore';
import { mediaAuditStore } from '../../store/mediaAuditStore';
import { fromStore } from '../fromStore';
import { createDocHits } from '../createDocHits';
import { Menu, type MenuItem } from '../ui/Menu';
import { MediaIcon } from '../ui/MediaIcon';
import { MediaDetailsDialog } from './MediaDetailsDialog';

// The media library's housekeeping surface: every file on disk, reconciled with
// what the boards reference, plus a way to re-run the processing that first read
// each file. Read-only about integrity — it never deletes; orphans are shown, not
// swept (that is gc_media's job, and only on a complete keep-set). Reprocessing is
// additive: it re-reads a file into a card's derived fields, never re-saving bytes.
//
// The file count lives on the toolbar's Objects badge — which is why the audit is a
// store (mediaAuditStore), readable by that sibling. The bulk actions are rendered
// here, as a Menu positioned into the surround's top-right corner, where the clusters
// dropdown sits on the other views.

type Check = 'checking' | 'ok' | 'bad';

/** An orphan the user can turn into a card — the import path handles both. */
function isAdoptable(file: string): boolean {
  return isImageFile(file) || isDocumentFile(file);
}

export function ObjectView() {
  const { selectCard, reprocessCard, reprocessAll, adoptOrphan } = boardStore.getState();
  // The one toolbar search box drives this view too (as it does the board and record).
  // Its write is already debounced (see Toolbar), so we read the settled query straight.
  const searchQuery = fromStore(boardStore, (s) => s.searchQuery);
  const indexing = fromStore(jobsStore, (s) => s.pending);

  // The status line written here is what the toolbar badge shows during a bulk op.
  // The view re-audits on mount — it is keyed on the board in App, so a board switch
  // remounts and refreshes.
  const rows = fromStore(mediaAuditStore, (s) => s.rows);
  const loading = fromStore(mediaAuditStore, (s) => s.loading);
  const error = fromStore(mediaAuditStore, (s) => s.error);
  const incomplete = fromStore(mediaAuditStore, (s) => s.incomplete);
  const { refresh, setStatus } = mediaAuditStore.getState();
  onMount(() => void refresh());

  // Each file's search-index status, for its badge. Refreshed on mount and every time
  // the index queue drains, so badges catch up as files finish extracting.
  const [indexStatus, setIndexStatus] = createSignal<Record<string, string>>({});
  const loadIndexStatus = async () => {
    try {
      const statuses = await storage.indexStatuses();
      setIndexStatus(Object.fromEntries(statuses.map((s) => [s.name, s.status])));
    } catch {
      // Best-effort: no badges rather than an error.
    }
  };
  createEffect(() => {
    if (indexing() === 0) void loadIndexStatus();
  });

  const [onlyIssues, setOnlyIssues] = createSignal(false);
  const [checks, setChecks] = createSignal<Record<string, Check>>({});
  // A boolean in-flight flag (disables the bulk actions) kept apart from the status
  // line, so a finished message never leaves the buttons stuck disabled.
  const [busy, setBusy] = createSignal(false);
  const [detailsRow, setDetailsRow] = createSignal<MediaRow | null>(null);

  // The search's two halves: the synchronous field match (q, against filename, title,
  // kind, status) and the file bodies the shell's index found (docHits, keyed by media
  // name like row.file). Both narrow the list; "Only issues" composes on top (AND).
  const q = () => normaliseQuery(searchQuery());
  const docHits = createDocHits(searchQuery);

  const issueCount = createMemo(() => countIssues(rows()));
  const shown = createMemo(() =>
    rows().filter((r) => (!onlyIssues() || isIssue(r.status)) && mediaRowMatchesWithDocs(r, q(), docHits())),
  );
  // Rows by file, not by object: every audit builds fresh rows.
  const rowByFile = createMemo(() => new Map(rows().map((r) => [r.file, r])));
  const shownFiles = () => shown().map((r) => r.file);

  const verify = async (file: string) => {
    setChecks((c) => ({ ...c, [file]: 'checking' }));
    try {
      const ok = await storage.verifyMedia(file);
      setChecks((c) => ({ ...c, [file]: ok ? 'ok' : 'bad' }));
    } catch {
      setChecks((c) => ({ ...c, [file]: 'bad' }));
    }
  };

  // Runs one card-level job with the in-flight flag up, then re-audits. Used for
  // both a single Reprocess and the bulk run, so the flag/refresh live in one place.
  const run = async (message: string, job: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(message);
    try {
      setStatus((await job()) || null);
    } catch {
      setStatus('That didn’t work.');
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const verifyEverything = async () => {
    const onDisk = rows().filter((r) => r.onDisk);
    setBusy(true);
    for (const [i, r] of onDisk.entries()) {
      setStatus(`Verifying ${i + 1}/${onDisk.length}…`);
      await verify(r.file);
    }
    setBusy(false);
    setStatus(null);
  };

  // The bulk actions, as the top-right Maintenance dropdown. "Only issues" is a
  // toggle here, shown only when there is something to filter down to.
  const maintenanceItems = createMemo((): MenuItem[] => [
    {
      label: 'Reprocess all',
      onSelect: () =>
        void run('Reprocessing all…', async () => {
          const { done } = await reprocessAll();
          return `Reprocessed ${count(done, 'card')}.`;
        }),
      disabled: busy(),
    },
    {
      label: indexing() > 0 ? `Indexing ${indexing()}…` : 'Rebuild search index',
      onSelect: () => void storage.reindexAll(),
      disabled: indexing() > 0,
    },
    { label: 'Verify all', onSelect: () => void verifyEverything(), disabled: busy() },
    { label: 'Refresh', onSelect: () => void refresh(), disabled: loading() },
    ...(issueCount() > 0
      ? [{ label: onlyIssues() ? 'Show all files' : 'Only issues', onSelect: () => setOnlyIssues((v) => !v) }]
      : []),
    { label: 'Media folder', onSelect: () => void storage.openMediaDir() },
  ]);

  return (
    <div class="record maintenance">
      <div class="app-canvas-panel nopan nowheel" data-position="top-right">
        <Menu label="Maintenance" items={maintenanceItems()} />
      </div>

      <Show when={error()}>
        <p class="modal__warn maintenance__error">{error()}</p>
      </Show>
      <Show when={incomplete()}>
        <p class="hint maintenance__note">
          A board couldn’t be read, so files it might reference are shown as
          “unreferenced?” rather than orphans.
        </p>
      </Show>

      <Show
        when={loading() || shown().length > 0}
        fallback={
          <p class="hint record__empty">
            {rows().length === 0
              ? 'The media library is empty.'
              : q()
                ? `No objects match “${searchQuery().trim()}”.`
                : 'No objects match the current filter.'}
          </p>
        }
      >
        <ul class="record__list">
          <For each={shownFiles()}>
            {(file) => (
              <MediaFileRow
                row={rowByFile().get(file)!}
                check={checks()[file]}
                indexState={indexStatus()[file]}
                onReprocess={(cardId) => void run('Reprocessing…', () => reprocessCard(cardId))}
                onVerify={verify}
                onAdopt={(file) => void run('Adding card…', () => adoptOrphan(file))}
                onSelect={selectCard}
                onDetails={setDetailsRow}
                busy={busy()}
              />
            )}
          </For>
        </ul>
      </Show>

      <Show when={detailsRow()}>
        {(row) => (
          <MediaDetailsDialog row={row()} indexState={indexStatus()[row().file]} onClose={() => setDetailsRow(null)} />
        )}
      </Show>
    </div>
  );
}

type RowProps = {
  row: MediaRow;
  check: Check | undefined;
  /** This file's search-index status ('indexed' | 'failed' | 'unsupported'), or
   *  undefined until it has been processed. */
  indexState: string | undefined;
  onReprocess: (cardId: string) => void;
  onVerify: (file: string) => void;
  onAdopt: (file: string) => void;
  onSelect: (id: string) => void;
  onDetails: (row: MediaRow) => void;
  busy: boolean;
};

function MediaFileRow(props: RowProps) {
  const file = props.row.file;
  // An orphan image or document can become a card, right here.
  const canAdopt = () => props.row.status === 'orphan' && isAdoptable(file);
  const isImage = () => props.row.owner?.mediaKind === 'image' || (!props.row.owner && isImageFile(file));
  return (
    <li class={`maintenance-row is-${props.row.status}`}>
      <span class="record-row__thumb">
        <Show when={isImage() && props.row.onDisk} fallback={<MediaIcon {...mediaIconFor(file, props.row.owner?.mediaKind)} />}>
          <img src={mediaSrc(file)} alt="" draggable={false} />
        </Show>
      </span>

      <span class="record-row__main">
        <span class="record-row__title" title={file}>
          {props.row.owner ? props.row.owner.title || 'Untitled' : file}
        </span>
        <span class="record-row__who">
          <Show when={props.row.owner} fallback="no card">
            {(owner) => (
              <button class="link-button" onClick={() => props.onSelect(owner().cardId)}>
                {owner().mediaKind} on {owner().cardKind}
              </button>
            )}
          </Show>
          {' · '}
          {size(props.row.size)}
        </span>
      </span>

      <Show when={props.row.status !== 'ok'}>
        <span class={`maintenance-row__status is-${props.row.status}`}>{STATUS_LABEL[props.row.status]}</span>
      </Show>
      <Show when={props.check === 'bad'}>
        <span class="maintenance-row__status is-missing">checksum ✗</span>
      </Show>
      <Show when={props.check === 'ok'}>
        <span class="maintenance-row__status is-ok">verified ✓</span>
      </Show>
      <Show when={props.indexState === 'failed'}>
        <span class="maintenance-row__status is-missing">index failed</span>
      </Show>
      <Show when={props.indexState === 'unsupported'}>
        <span class="maintenance-row__status is-unknown">no text</span>
      </Show>

      <span class="maintenance-row__actions">
        <button class="link-button" onClick={() => props.onDetails(props.row)}>
          Details
        </button>
        <Show when={canAdopt()}>
          <button class="link-button" onClick={() => props.onAdopt(file)} disabled={props.busy}>
            Add as card
          </button>
        </Show>
        <Show when={props.row.owner}>
          {(owner) => (
            <button class="link-button" onClick={() => props.onReprocess(owner().cardId)} disabled={props.busy}>
              Reprocess
            </button>
          )}
        </Show>
        <Show when={props.row.onDisk}>
          <button
            class="link-button"
            onClick={() => void storage.reindexMedia([file])}
            title="Re-read this file's text into the search index"
          >
            Reindex
          </button>
          <button class="link-button" onClick={() => props.onVerify(file)} disabled={props.check === 'checking'}>
            {props.check === 'checking' ? 'Verifying…' : 'Verify'}
          </button>
          <button class="link-button" onClick={() => void storage.openMedia(file)}>
            Open
          </button>
        </Show>
      </span>
    </li>
  );
}
