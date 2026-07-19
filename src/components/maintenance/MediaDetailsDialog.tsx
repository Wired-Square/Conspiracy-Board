import { useEffect, useState } from 'react';
import { useBoardStore } from '../../store/boardStore';
import { storage } from '../../storage';
import type { MediaMeta } from '../../storage/StorageAdapter';
import { formatBytes } from '../../lib/format';
import { formatOccurredAt } from '../../lib/dates';
import { STATUS_LABEL, type MediaRow } from '../../lib/maintenance';
import { Modal } from '../ui/Modal';
import { MetaList } from '../ui/MetaList';

// What one media file is and what it carries — reached from a row's "Details" button.
// The identity (name, size, status) is already in hand on the MediaRow; the embedded
// properties (a document's title/author, a photo's dimensions/EXIF) are read live from
// the file on open via extractMediaMeta, so this works for orphans too, not just files
// a card owns.

/** 'indexed' | 'failed' | 'unsupported' | (no row yet) → a phrase for the dialog. */
const INDEX_LABEL: Record<string, string> = {
  indexed: 'indexed',
  failed: 'extraction failed',
  unsupported: 'no extractable text',
};

/** A date-time for an ISO-8601 string via the shared formatter, or the raw string if
 *  it won't parse (embedded file metadata isn't always well-formed). */
function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined;
  return Number.isNaN(new Date(iso).getTime()) ? iso : formatOccurredAt(iso, 'minute');
}

/** The non-empty embedded properties, as [label, value] pairs for MetaList. */
function metaFacts(meta: MediaMeta): [string, string][] {
  const facts: [string, string][] = [];
  const add = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') facts.push([label, String(value)]);
  };
  add('Title', meta.title);
  add('Author', meta.author);
  if (meta.width && meta.height) add('Dimensions', `${meta.width} × ${meta.height}`);
  add('Pages', meta.pages);
  add('Words', meta.words);
  add('Created', formatWhen(meta.created));
  add('Modified', formatWhen(meta.modified));
  add('Taken', formatWhen(meta.takenAt));
  const camera = [meta.cameraMake, meta.cameraModel].filter(Boolean).join(' ');
  add('Camera', camera || undefined);
  if (meta.latitude != null && meta.longitude != null) {
    add('Location', `${meta.latitude}, ${meta.longitude}`);
  }
  return facts;
}

export function MediaDetailsDialog({
  row,
  indexState,
  onClose,
}: {
  row: MediaRow;
  indexState?: string;
  onClose: () => void;
}) {
  const { file, owner, status, size, onDisk } = row;
  const selectCard = useBoardStore((s) => s.selectCard);

  // The embedded properties are a live re-parse of the file, so only for on-disk files
  // and only on open. Stale-guarded in case the dialog is closed mid-read.
  const [meta, setMeta] = useState<MediaMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(onDisk);
  useEffect(() => {
    if (!onDisk) return;
    let live = true;
    setMetaLoading(true);
    storage
      .extractMediaMeta(file)
      .then((m) => live && setMeta(m))
      .catch(() => live && setMeta(null))
      .finally(() => live && setMetaLoading(false));
    return () => {
      live = false;
    };
  }, [file, onDisk]);

  const identity: [string, string][] = [
    ['File', file],
    ['Size', size != null ? formatBytes(size) : '—'],
    ['On disk', onDisk ? 'yes' : 'no'],
    ['Status', STATUS_LABEL[status]],
    ['Search index', indexState ? INDEX_LABEL[indexState] ?? indexState : 'pending'],
  ];

  const showCard = () => {
    if (owner) {
      selectCard(owner.cardId);
      onClose();
    }
  };

  const facts = meta ? metaFacts(meta) : [];

  return (
    <Modal
      title={owner ? owner.title || 'Untitled' : file}
      onClose={onClose}
      footer={
        onDisk ? (
          <button onClick={() => void storage.openMedia(file)}>Open file</button>
        ) : undefined
      }
    >
      <MetaList facts={identity} />

      {owner ? (
        <p className="media-details__owner">
          Used by{' '}
          <button className="link-button" onClick={showCard}>
            {owner.title || 'Untitled'}
          </button>{' '}
          ({owner.mediaKind} on {owner.cardKind})
        </p>
      ) : (
        <p className="hint">No card references this file.</p>
      )}

      {onDisk && (
        <>
          <span className="panel-heading media-details__heading">File properties</span>
          {metaLoading ? (
            <p className="hint">Reading file…</p>
          ) : facts.length ? (
            <MetaList facts={facts} />
          ) : (
            <p className="hint">No embedded properties.</p>
          )}
        </>
      )}
    </Modal>
  );
}
