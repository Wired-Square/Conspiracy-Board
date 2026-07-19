import { useRef } from 'react';
import type { Card } from '../../types/board';
import { useBoardStore } from '../../store/boardStore';
import { storage } from '../../storage';
import type { MediaMeta } from '../../storage/StorageAdapter';
import { saveFile } from '../../storage/media';
import { documentMime } from '../../lib/import/files';
import { pickDocumentMeta } from '../../lib/import/meta';
import { formatOccurredAt } from '../../lib/dates';
import { MetaList } from '../ui/MetaList';

/**
 * The file behind a document card. A document *is* a piece of the record — a
 * warrant, a filing, an invoice — so it can carry the actual file, kept in the
 * media library and opened in whatever the OS uses for it (Preview for a PDF).
 *
 * No inline preview: that would want the PDF served into an <iframe>, a hole in
 * the CSP for the sake of a thumbnail. Opening it in the real app is both safer
 * and what someone reading a filing actually wants.
 */
export function DocumentFields({ card }: { card: Card }) {
  const updateCard = useBoardStore((s) => s.updateCard);
  const fileRef = useRef<HTMLInputElement>(null);
  const doc = card.document ?? {};

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    // A previous file is left for the sweep — content-addressed media may be
    // shared, so it is not ours to delete the moment this card replaces it. The
    // same read the drop-import does, so an attached file carries its metadata too.
    const stored = await saveFile(file);
    const meta = await storage.extractMediaMeta(stored).catch(() => ({}) as MediaMeta);
    updateCard(card.id, {
      document: { file: stored, name: file.name, mime: file.type || documentMime(file.name), ...pickDocumentMeta(meta) },
      // Land it on the timeline by its own date, unless the card is already dated.
      ...(meta.created && !card.occurredAt ? { occurredAt: meta.created } : {}),
    });
  };

  const facts: [string, string][] = [];
  if (doc.title) facts.push(['Title', doc.title]);
  if (doc.author) facts.push(['Author', doc.author]);
  if (doc.pages != null) facts.push(['Pages', String(doc.pages)]);
  if (doc.words != null) facts.push(['Words', doc.words.toLocaleString('en-AU')]);
  if (doc.created) facts.push(['Created', formatOccurredAt(doc.created, 'day')]);
  if (doc.modified) facts.push(['Modified', formatOccurredAt(doc.modified, 'day')]);

  return (
    <div className="field">
      <span>File</span>
      {doc.file ? (
        <div className="field__row">
          <button onClick={() => void storage.openMedia(doc.file!)}>Open {doc.name ?? 'file'}</button>
          <button className="link-button" onClick={() => fileRef.current?.click()}>
            Replace
          </button>
          <button className="link-button" onClick={() => updateCard(card.id, { document: {} })}>
            Remove
          </button>
        </div>
      ) : (
        <div className="field__row">
          <button onClick={() => fileRef.current?.click()}>Attach file</button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <MetaList facts={facts} />
      <span className="field__hint">
        Kept in the library and opened in the app it belongs to. The card is a note; this
        is the paper it is about.
      </span>
    </div>
  );
}
