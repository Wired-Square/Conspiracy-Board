import type { Card } from '../../types/board';
import { storage } from '../../storage';
import { documentFacts } from '../../lib/mediaFacts';
import { MetaList } from '../ui/MetaList';
import { useBoardStore } from '../../hooks/useStores';

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
  const doc = card.document ?? {};

  const onPick = async () => {
    const [path] = await storage.pickPaths();
    if (!path) return;
    // A previous file is left for the sweep — content-addressed media may be
    // shared, so it is not ours to delete the moment this card replaces it. The
    // same read an import does, so an attached file carries its metadata too.
    const { document, occurredAt } = await storage.attachDocument(path);
    updateCard(card.id, {
      document,
      // Land it on the timeline by its own date, unless the card is already dated.
      ...(occurredAt && !card.occurredAt ? { occurredAt } : {}),
    });
  };

  return (
    <div className="field">
      <span>File</span>
      {doc.file ? (
        <div className="field__row">
          <button onClick={() => void storage.openMedia(doc.file!)}>Open {doc.name ?? 'file'}</button>
          <button className="link-button" onClick={() => void onPick()}>
            Replace
          </button>
          <button className="link-button" onClick={() => updateCard(card.id, { document: {} })}>
            Remove
          </button>
        </div>
      ) : (
        <div className="field__row">
          <button onClick={() => void onPick()}>Attach file</button>
        </div>
      )}
      <MetaList facts={documentFacts(doc)} />
      <span className="field__hint">
        Kept in the library and opened in the app it belongs to. The card is a note; this
        is the paper it is about.
      </span>
    </div>
  );
}
