import type { Board, Card } from '../types/board';

/** A card's media, tagged with what kind it is — each is reprocessed a different
 *  way (see boardStore.reprocessCard) and shown with its own row in maintenance. */
export type CardMediaKind = 'image' | 'eml' | 'attachment' | 'document';
export type CardMediaEntry = { file: string; kind: CardMediaKind };

/**
 * Every media file a card points at, tagged: its picture, the original .eml, an
 * attachment, a document. This is the *only* enumeration of the media-bearing
 * fields, and (through `boardMediaRefs`) the keep-set for a destructive sweep
 * (`gcMedia` → `gc_media`): a media field added to the model but left out here
 * would have its files quietly deleted the next time GC runs. Add the field to the
 * model (`types/board.ts`) and to this list together — the field comments there
 * point back here to say so.
 */
export function cardMediaEntries(card: Card): CardMediaEntry[] {
  const out: CardMediaEntry[] = [];
  if (card.imageFile) out.push({ file: card.imageFile, kind: 'image' });
  if (card.email?.emlFile) out.push({ file: card.email.emlFile, kind: 'eml' });
  for (const a of card.email?.attachments ?? []) if (a.file) out.push({ file: a.file, kind: 'attachment' });
  if (card.document?.file) out.push({ file: card.document.file, kind: 'document' });
  return out;
}

/** Every media file a board references — the keep-set for a GC sweep. */
export function boardMediaRefs(board: Board): string[] {
  return board.cards.flatMap((card) => cardMediaEntries(card).map((e) => e.file));
}
