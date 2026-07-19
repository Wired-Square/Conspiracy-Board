import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';
import { useBoardStore } from '../../store/boardStore';
import { jobsPending, useJobQueueStore } from '../../store/jobQueueStore';
import { useMediaAuditStore } from '../../store/mediaAuditStore';
import { storage } from '../../storage';
import { mediaSrc } from '../../storage/media';
import { isDocumentFile, isImageFile } from '../../lib/import/files';
import { formatBytes, plural } from '../../lib/format';
import { useDocHits } from '../../hooks/useDocHits';
import { countIssues, isIssue, mediaRowMatchesWithDocs, STATUS_LABEL, type MediaRow } from '../../lib/maintenance';
import { normaliseQuery } from '../../lib/search';
import { mediaIconFor } from '../../lib/mediaIcon';
import { Menu, type MenuItem } from '../ui/Menu';
import { MediaIcon } from '../ui/MediaIcon';
import { MediaDetailsDialog } from './MediaDetailsDialog';

// The media library's housekeeping surface: every file on disk, reconciled with
// what the boards reference, plus a way to re-run the processing that first read
// each file. Read-only about integrity — it never deletes; orphans are shown, not
// swept (that is gc_media's job, and only on a complete keep-set). Reprocessing is
// additive: it re-reads a file into a card's derived fields, never re-saving bytes.
//
// The file count moved out to the toolbar's Objects badge — which is why the audit is a
// store (useMediaAuditStore), readable by that sibling, rather than a hook. The bulk
// actions are still rendered here, but as a Menu positioned into the surround's top-right
// corner (the <Panel> below) where the clusters dropdown sits on the other views.

type Check = 'checking' | 'ok' | 'bad';

/** An orphan the user can turn into a card — the import path handles both. */
function isAdoptable(file: string): boolean {
  return isImageFile(file) || isDocumentFile(file);
}

export function ObjectView() {
  const selectCard = useBoardStore((s) => s.selectCard);
  // The one toolbar search box drives this view too (as it does the board and record).
  // Its write is already debounced (see Toolbar), so we read the settled query straight.
  const searchQuery = useBoardStore((s) => s.searchQuery);
  const reprocessCard = useBoardStore((s) => s.reprocessCard);
  const reprocessAll = useBoardStore((s) => s.reprocessAll);
  const adoptOrphan = useBoardStore((s) => s.adoptOrphan);
  const reindexAll = useJobQueueStore((s) => s.reindexAll);
  const enqueue = useJobQueueStore((s) => s.enqueue);
  const indexing = useJobQueueStore(jobsPending);

  // The audit lives in a store so the toolbar badge can read the count; the status line
  // it writes is what the badge shows during a bulk op. The view re-audits on mount —
  // it is keyed on the board in App, so a board switch remounts and refreshes.
  const rows = useMediaAuditStore((s) => s.rows);
  const loading = useMediaAuditStore((s) => s.loading);
  const error = useMediaAuditStore((s) => s.error);
  const incomplete = useMediaAuditStore((s) => s.incomplete);
  const refresh = useMediaAuditStore((s) => s.refresh);
  const setStatus = useMediaAuditStore((s) => s.setStatus);
  useEffect(() => void refresh(), [refresh]);

  // Each file's search-index status, for its badge. Refreshed on mount and every time
  // the index queue drains, so badges catch up as files finish extracting.
  const [indexStatus, setIndexStatus] = useState<Record<string, string>>({});
  const loadIndexStatus = useCallback(async () => {
    try {
      const statuses = await storage.indexStatuses();
      setIndexStatus(Object.fromEntries(statuses.map((s) => [s.name, s.status])));
    } catch {
      // Best-effort: no badges rather than an error.
    }
  }, []);
  useEffect(() => {
    if (indexing === 0) void loadIndexStatus();
  }, [indexing, loadIndexStatus]);

  const reindex = useCallback((file: string) => enqueue([file], { force: true }), [enqueue]);

  const [onlyIssues, setOnlyIssues] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  // A boolean in-flight flag (disables the bulk actions) kept apart from the status
  // line, so a finished message never leaves the buttons stuck disabled.
  const [busy, setBusy] = useState(false);
  // The file whose metadata dialog is open, or null. Local because the trigger is this
  // view's own per-row button (the idiomatic one-parent-owns-it dialog).
  const [detailsRow, setDetailsRow] = useState<MediaRow | null>(null);

  // The search's two halves: the synchronous field match (q, against filename, title,
  // kind, status) and the file bodies the shell's index found (docHits, keyed by media
  // name like row.file). Both narrow the list; "Only issues" composes on top (AND).
  const q = normaliseQuery(searchQuery);
  const docHits = useDocHits(searchQuery);

  const issueCount = useMemo(() => countIssues(rows), [rows]);
  const shown = useMemo(
    () =>
      rows.filter(
        (r) => (!onlyIssues || isIssue(r.status)) && mediaRowMatchesWithDocs(r, q, docHits),
      ),
    [onlyIssues, rows, q, docHits],
  );

  const verify = useCallback(async (file: string) => {
    setChecks((c) => ({ ...c, [file]: 'checking' }));
    try {
      const ok = await storage.verifyMedia(file);
      setChecks((c) => ({ ...c, [file]: ok ? 'ok' : 'bad' }));
    } catch {
      setChecks((c) => ({ ...c, [file]: 'bad' }));
    }
  }, []);

  // Runs one card-level job with the in-flight flag up, then re-audits. Used for
  // both a single Reprocess and the bulk run, so the flag/refresh live in one place.
  const run = useCallback(
    async (message: string, job: () => Promise<string | void>) => {
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
    },
    [refresh, setStatus],
  );

  const reprocess = useCallback(
    (cardId: string) => void run('Reprocessing…', () => reprocessCard(cardId)),
    [run, reprocessCard],
  );

  const reprocessEverything = useCallback(
    () =>
      void run('Reprocessing all…', async () => {
        const { done } = await reprocessAll();
        return `Reprocessed ${plural(done, 'card')}.`;
      }),
    [run, reprocessAll],
  );

  const adopt = useCallback(
    (file: string) => void run('Adding card…', () => adoptOrphan(file)),
    [run, adoptOrphan],
  );

  const verifyEverything = useCallback(async () => {
    const onDisk = rows.filter((r) => r.onDisk);
    setBusy(true);
    for (const [i, r] of onDisk.entries()) {
      setStatus(`Verifying ${i + 1}/${onDisk.length}…`);
      await verify(r.file);
    }
    setBusy(false);
    setStatus(null);
  }, [rows, verify, setStatus]);

  // The bulk actions, as the top-right Maintenance dropdown (where the clusters panel
  // sits on the other views). Built each render so the labels/disabled states track the
  // job queue and in-flight flag; "Only issues" is a toggle here, shown only when there
  // is something to filter down to.
  const maintenanceItems: MenuItem[] = [
    { label: 'Reprocess all', onSelect: reprocessEverything, disabled: busy },
    {
      label: indexing > 0 ? `Indexing ${indexing}…` : 'Rebuild search index',
      onSelect: () => void reindexAll(),
      disabled: indexing > 0,
    },
    { label: 'Verify all', onSelect: () => void verifyEverything(), disabled: busy },
    { label: 'Refresh', onSelect: () => void refresh(), disabled: loading },
    ...(issueCount > 0
      ? [{ label: onlyIssues ? 'Show all files' : 'Only issues', onSelect: () => setOnlyIssues((v) => !v) }]
      : []),
    { label: 'Media folder', onSelect: () => void storage.openMediaDir() },
  ];

  return (
    <div className="record maintenance">
      <Panel position="top-right">
        <Menu label="Maintenance" items={maintenanceItems} />
      </Panel>

      {error && <p className="modal__warn maintenance__error">{error}</p>}
      {incomplete && (
        <p className="hint maintenance__note">
          A board couldn’t be read, so files it might reference are shown as
          “unreferenced?” rather than orphans.
        </p>
      )}

      {!loading && rows.length === 0 ? (
        <p className="hint record__empty">The media library is empty.</p>
      ) : !loading && shown.length === 0 ? (
        <p className="hint record__empty">
          {q ? `No objects match “${searchQuery.trim()}”.` : 'No objects match the current filter.'}
        </p>
      ) : (
        <ul className="record__list">
          {shown.map((row) => (
            <MediaFileRow
              key={row.file}
              row={row}
              check={checks[row.file]}
              indexState={indexStatus[row.file]}
              onReprocess={reprocess}
              onReindex={reindex}
              onVerify={verify}
              onAdopt={adopt}
              onSelect={selectCard}
              onDetails={setDetailsRow}
              busy={busy}
            />
          ))}
        </ul>
      )}

      {detailsRow && (
        <MediaDetailsDialog
          row={detailsRow}
          indexState={indexStatus[detailsRow.file]}
          onClose={() => setDetailsRow(null)}
        />
      )}
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
  onReindex: (file: string) => void;
  onVerify: (file: string) => void;
  onAdopt: (file: string) => void;
  onSelect: (id: string) => void;
  onDetails: (row: MediaRow) => void;
  busy: boolean;
};

function MediaFileRowImpl({
  row,
  check,
  indexState,
  onReprocess,
  onReindex,
  onVerify,
  onAdopt,
  onSelect,
  onDetails,
  busy,
}: RowProps) {
  const { file, owner, status, onDisk } = row;
  // An orphan image or document can become a card, right here.
  const canAdopt = status === 'orphan' && isAdoptable(file);
  const isImage = owner?.mediaKind === 'image' || (!owner && isImageFile(file));
  return (
    <li className={`maintenance-row is-${status}`}>
      <span className="record-row__thumb">
        {isImage && onDisk ? (
          <img src={mediaSrc(file)} alt="" draggable={false} />
        ) : (
          <MediaIcon {...mediaIconFor(file, owner?.mediaKind)} />
        )}
      </span>

      <span className="record-row__main">
        <span className="record-row__title" title={file}>
          {owner ? owner.title || 'Untitled' : file}
        </span>
        <span className="record-row__who">
          {owner ? (
            <button className="link-button" onClick={() => onSelect(owner.cardId)}>
              {owner.mediaKind} on {owner.cardKind}
            </button>
          ) : (
            'no card'
          )}
          {' · '}
          {formatBytes(row.size)}
        </span>
      </span>

      {status !== 'ok' && <span className={`maintenance-row__status is-${status}`}>{STATUS_LABEL[status]}</span>}
      {check === 'bad' && <span className="maintenance-row__status is-missing">checksum ✗</span>}
      {check === 'ok' && <span className="maintenance-row__status is-ok">verified ✓</span>}
      {indexState === 'failed' && <span className="maintenance-row__status is-missing">index failed</span>}
      {indexState === 'unsupported' && <span className="maintenance-row__status is-unknown">no text</span>}

      <span className="maintenance-row__actions">
        <button className="link-button" onClick={() => onDetails(row)}>
          Details
        </button>
        {canAdopt && (
          <button className="link-button" onClick={() => onAdopt(file)} disabled={busy}>
            Add as card
          </button>
        )}
        {owner && (
          <button className="link-button" onClick={() => onReprocess(owner.cardId)} disabled={busy}>
            Reprocess
          </button>
        )}
        {onDisk && (
          <button
            className="link-button"
            onClick={() => onReindex(file)}
            title="Re-read this file's text into the search index"
          >
            Reindex
          </button>
        )}
        {onDisk && (
          <button
            className="link-button"
            onClick={() => onVerify(file)}
            disabled={check === 'checking'}
          >
            {check === 'checking' ? 'Verifying…' : 'Verify'}
          </button>
        )}
        {onDisk && (
          <button className="link-button" onClick={() => void storage.openMedia(file)}>
            Open
          </button>
        )}
      </span>
    </li>
  );
}

// Memoised: a large library is many rows, and a single verify/reprocess must not
// re-render every other row.
const MediaFileRow = memo(MediaFileRowImpl);
