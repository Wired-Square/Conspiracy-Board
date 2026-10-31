import type { Board, Card } from '../types/board';
import { storage } from '../storage';
import { extOf } from '../lib/fileTypes';
import { b64ToBytes } from '../lib/base64';

// Board-media chores that need storage: moving a legacy board's inline pictures
// into the media library, and recovering an email card's attachments from its .eml.

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
 * http(s) URL is downloaded by the shell (`storage.downloadImage`) — either way `imageFile`
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
          file = await storage.downloadImage(url);
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
 * attachments match what the parser now finds (older imports dropped Apple Mail's
 * inline-disposition documents) — or null if there is nothing to read or the
 * message would not parse. Only the attachment list is rebuilt, and a *missing*
 * picture filled. Run on demand from the maintenance view's Reprocess.
 */
export async function recoverCardAttachments(card: Card): Promise<Partial<Card> | null> {
  const eml = card.email?.emlFile;
  if (!eml) return null;
  const found = await storage.recoverEmailAttachments(eml, card.imageFile !== null);
  if (!found) return null;
  return {
    ...(found.imageFile ? { imageFile: found.imageFile } : {}),
    email: { ...card.email!, attachments: found.attachments },
  };
}
