import type { Board, Card } from '../types/board';
import { storage } from '../storage';

// Board-media chores that need storage: moving a legacy board's inline pictures
// into the media library, and recovering an email card's attachments from its .eml.

const LOCALISED = ['data:', 'http://', 'https://'];

/**
 * Bring a board's pictures into the media library so no card depends on a URL. The
 * shell decodes a card's data: URL or downloads its http(s) one
 * (`storage.downloadImage`) — either way `imageFile` is set and `imageUrl` cleared, leaving `imageCrop` at its default so the picture
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
      if (card.imageFile || !url || !LOCALISED.some((scheme) => url.startsWith(scheme))) return card;
      try {
        const file = await storage.downloadImage(url);
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
