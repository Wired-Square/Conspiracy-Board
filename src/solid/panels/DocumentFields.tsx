/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import type { Card } from '../../types/board';
import { storage } from '../../storage';
import { documentFacts } from '../../lib/mediaFacts';
import { boardStore } from '../../store/boardStore';
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
export function DocumentFields(props: { card: Card }) {
  const { updateCard } = boardStore.getState();
  const doc = () => props.card.document ?? {};

  const onPick = async () => {
    const [path] = await storage.pickPaths();
    if (!path) return;
    // A previous file is left for the sweep — content-addressed media may be
    // shared, so it is not ours to delete the moment this card replaces it. The
    // same read an import does, so an attached file carries its metadata too.
    const { document, occurredAt } = await storage.attachDocument(path);
    updateCard(props.card.id, {
      document,
      // Land it on the timeline by its own date, unless the card is already dated.
      ...(occurredAt && !props.card.occurredAt ? { occurredAt } : {}),
    });
  };

  return (
    <div class="field">
      <span>File</span>
      <Show
        when={doc().file}
        fallback={
          <div class="field__row">
            <button onClick={() => void onPick()}>Attach file</button>
          </div>
        }
      >
        {(file) => (
          <div class="field__row">
            <button onClick={() => void storage.openMedia(file())}>Open {doc().name ?? 'file'}</button>
            <button class="link-button" onClick={() => void onPick()}>
              Replace
            </button>
            <button class="link-button" onClick={() => updateCard(props.card.id, { document: {} })}>
              Remove
            </button>
          </div>
        )}
      </Show>
      <MetaList facts={documentFacts(doc())} />
      <span class="field__hint">
        Kept in the library and opened in the app it belongs to. The card is a note; this
        is the paper it is about.
      </span>
    </div>
  );
}
