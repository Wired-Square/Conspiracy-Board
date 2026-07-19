import type { Board, Card } from '../types/board';
import { storage } from '../storage';
import { downloadImage, extOf } from '../storage/media';
import { b64ToBytes } from '../lib/base64';
import { parseEmailFile } from '../lib/email/parseEmails';
import { persistDraftMedia } from '../lib/email/persistMedia';

// Two board-media chores that need the parsed board: collecting every file a
// board still points at (for the GC keep-set), and moving a legacy board's
// inline base64 pictures out into the media library. Both live here rather than
// in the store so the store stays about board state, not storage shape.

/** A card's media, tagged with what kind it is — each is reprocessed a different
 *  way (see boardStore.reprocessCard) and shown with its own row in maintenance. */
export type CardMediaKind = 'image' | 'eml' | 'attachment' | 'document';
export type CardMediaEntry = { file: string; kind: CardMediaKind };

/**
 * Every media file a card points at, tagged: its picture, the original .eml, an
 * attachment, a document. This is the *only* enumeration of the media-bearing
 * fields, and (through `cardMediaRefs`) the keep-set for a destructive sweep
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

/** Just the filenames a card points at — the keep-set for a GC sweep. */
export function cardMediaRefs(card: Card): string[] {
  return cardMediaEntries(card).map((e) => e.file);
}

/** Every media file a board references — the keep-set for a GC sweep. */
export function boardMediaRefs(board: Board): string[] {
  return board.cards.flatMap(cardMediaRefs);
}

/**
 * Decode a data: URL to bytes without `fetch` — the app's connect-src CSP does
 * not list `data:`, so fetching one would be blocked. Handles the base64 and the
 * percent-encoded forms.
 */
function dataUrlToBytes(url: string): ArrayBuffer {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma); // between 'data:' and the comma
  const payload = url.slice(comma + 1);
  return meta.includes(';base64')
    ? b64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload)).buffer;
}

/**
 * Bring a board's pictures into the media library so no card depends on a URL. A
 * card whose `imageUrl` is a data: URL has its bytes decoded and written; a remote
 * http(s) URL is downloaded by the shell (`downloadImage`) — either way `imageFile`
 * is set and `imageUrl` cleared, leaving `imageCrop` at its default so the picture
 * is unchanged. Runs on every load so an imported or newly-linked board is caught
 * too; after the first successful pass a card has `imageFile` and there is nothing
 * to do. Best-effort per card: a picture that won't decode or download is left as
 * the URL it was rather than dropped, and converts on a later pass. Returns whether
 * anything changed, so the caller rewrites the board once, URL-free.
 */
export async function migrateBoardMedia(
  board: Board,
): Promise<{ board: Board; changed: boolean }> {
  let changed = false;
  const cards = await Promise.all(
    board.cards.map(async (card) => {
      const url = card.imageUrl;
      if (card.imageFile || !url) return card;
      try {
        let file: string | null = null;
        if (url.startsWith('data:')) {
          // The mime sits between 'data:' and the comma — extOf takes it from there.
          file = await storage.saveMedia(dataUrlToBytes(url), extOf(undefined, url.slice(5, url.indexOf(','))));
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
          file = await downloadImage(url);
        }
        if (!file) return card; // A scheme we don't localise — leave it be.
        changed = true;
        return { ...card, imageFile: file, imageUrl: null };
      } catch {
        // Offline, a dead link, or a picture that won't decode: keep the URL it was
        // — it still displays, and the next load has another go.
        return card;
      }
    }),
  );
  return changed ? { board: { ...board, cards }, changed } : { board, changed };
}

/**
 * Re-read one email card's original .eml and return the fields to patch so its
 * attachments match what the parser now finds — or null if there is nothing to
 * read or the message would not parse.
 *
 * The bug this repairs: older imports dropped every `Content-Disposition: inline`
 * part as layout, but Apple Mail marks genuine attachments — a PDF, a Word document
 * — inline so they preview in the message, so those files never reached the card.
 * The whole message was kept as its .eml, so re-parsing it with the corrected rule
 * (see isInlinePart in parseEmails) gets them back.
 *
 * Additive and idempotent: only the attachment list is rebuilt (and a *missing*
 * picture filled — a chosen one is never clobbered), the file bytes are content-
 * addressed so re-saving is free, and the .eml is already stored so it is not
 * written again. Run on demand from the maintenance view's Reprocess.
 */
export async function recoverCardAttachments(card: Card): Promise<Partial<Card> | null> {
  const eml = card.email?.emlFile;
  if (!eml) return null;
  const bytes = await storage.readMedia(eml);
  const { drafts } = await parseEmailFile(`${card.title || 'message'}.eml`, bytes);
  const draft = drafts[0];
  if (!draft) return null;
  draft.email.emlFile = eml; // already on disk — don't rewrite it
  // The card keeps the picture it has; don't re-hash and re-save the message's
  // image only to discard it below.
  if (card.imageFile) draft.media.image = undefined;
  const persisted = await persistDraftMedia(draft);
  return {
    ...(persisted.imageFile ? { imageFile: persisted.imageFile } : {}),
    email: { ...card.email!, attachments: persisted.email?.attachments ?? [] },
  };
}
