import { Show, createResource } from 'solid-js';
import { size } from '@wired-square/kit/core';
import { storage } from '../../storage';
import type { MediaMeta } from '../../storage/StorageAdapter';
import { formatOccurredAt } from '../../lib/dates';
import { STATUS_LABEL, type MediaRow } from '../../lib/maintenance';
import { boardStore } from '../../store/boardStore';
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

export function MediaDetailsDialog(props: { row: MediaRow; indexState?: string; onClose: () => void }) {
  // The embedded properties are a live re-parse of the file, so only for on-disk files
  // and only on open. A resource keeps only the latest read, so a row changed mid-read
  // never shows the old file's properties.
  const [meta] = createResource(
    () => props.row.onDisk && props.row.file,
    (file) => storage.extractMediaMeta(file).catch(() => null),
  );

  const identity = (): [string, string][] => [
    ['File', props.row.file],
    ['Size', size(props.row.size)],
    ['On disk', props.row.onDisk ? 'yes' : 'no'],
    ['Status', STATUS_LABEL[props.row.status]],
    ['Search index', props.indexState ? INDEX_LABEL[props.indexState] ?? props.indexState : 'pending'],
  ];

  const showCard = (cardId: string) => {
    boardStore.getState().selectCard(cardId);
    props.onClose();
  };

  const facts = () => {
    const m = meta();
    return m ? metaFacts(m) : [];
  };

  return (
    <Modal
      title={props.row.owner ? props.row.owner.title || 'Untitled' : props.row.file}
      onClose={props.onClose}
      footer={
        props.row.onDisk ? (
          <button onClick={() => void storage.openMedia(props.row.file)}>Open file</button>
        ) : undefined
      }
    >
      <MetaList facts={identity()} />

      <Show when={props.row.owner} fallback={<p class="hint">No card references this file.</p>}>
        {(owner) => (
          <p class="media-details__owner">
            Used by{' '}
            <button class="link-button" onClick={() => showCard(owner().cardId)}>
              {owner().title || 'Untitled'}
            </button>{' '}
            ({owner().mediaKind} on {owner().cardKind})
          </p>
        )}
      </Show>

      <Show when={props.row.onDisk}>
        <span class="panel-heading media-details__heading">File properties</span>
        <Show when={!meta.loading} fallback={<p class="hint">Reading file…</p>}>
          <Show when={facts().length} fallback={<p class="hint">No embedded properties.</p>}>
            <MetaList facts={facts()} />
          </Show>
        </Show>
      </Show>
    </Modal>
  );
}
