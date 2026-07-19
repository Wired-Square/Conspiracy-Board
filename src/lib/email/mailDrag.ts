import type { Card } from '../../types/board';
import { emptyEmailMeta } from './meta';

// Dragging a message out of Apple Mail gives the page two strings and nothing
// else — no file, no readable promise, no directory entry:
//
//   text/plain     "TPP Wholesale Pty Ltd Invoice No: 14900663"   ← the subject
//   text/uri-list  "message:%3C2109994232...@...netregistry.net%3E"
//
// The body is never offered to a webview, so this makes the card from the two
// facts we are given and the shell fills it in. The Message-ID is the valuable
// one: it is what lets the arriving .eml recognise this card and complete it in
// place (see addCards and src/platform/mailDrops.ts), and the message: URL that
// reopens the original in Mail is a pure function of it (see mailUrlFor).

const MESSAGE_URL = /^message:(?:\/\/)?(.+)$/i;

/**
 * Pull the Message-ID out of a `message:` URL.
 *
 * Mail percent-encodes the angle brackets: `message:%3Cabc@host%3E`. Decoding
 * yields `<abc@host>`, byte-identical to what the MIME parser stores for the
 * same message — that identity is what makes completion possible.
 */
export function messageIdFromUrl(url: string): string | null {
  const encoded = MESSAGE_URL.exec(url)?.[1];
  if (!encoded) return null;

  let id: string;
  try {
    id = decodeURIComponent(encoded).trim();
  } catch {
    return null; // malformed escapes
  }
  return /^<.+>$/.test(id) ? id : null;
}

/**
 * The `message:` URL that reopens a message in Mail.
 *
 * Derived rather than stored: Mail encodes only the angle brackets, leaving `@`
 * and `.` literal, so the URL is a total function of the Message-ID we already
 * hold. (encodeURIComponent would not do — it escapes `@` too.) This is why the
 * link never needs to live in the card's notes, where a user editing their own
 * prose could delete it.
 */
export function mailUrlFor(messageId: string): string {
  return `message:${messageId.replace('<', '%3C').replace('>', '%3E')}`;
}

/** A body is on its way. Transient — the import replaces these notes outright. */
export const MAIL_BODY_PENDING = '_Fetching this message from Mail…_';

/** A body was asked for and didn't come. The manual route still works. */
export const MAIL_BODY_FAILED =
  "_Mail didn't hand this message over. Import the .eml to fill this card in._";

/**
 * Read an Apple Mail drag into the card it should become, or null if this drag
 * isn't one.
 *
 * Takes the already-extracted strings rather than a DataTransfer: its items are
 * neutered after the first await, so the caller must read them synchronously —
 * which conveniently keeps the DOM out of this layer.
 */
export function readMailDrop(
  uriList: string,
  text: string,
): Partial<Omit<Card, 'id' | 'position'>> | null {
  // A uri-list may hold several URLs, one per line, with # comments.
  const url = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && MESSAGE_URL.test(l));
  if (!url) return null;

  return {
    title: text.trim() || '(no subject)',
    kind: 'email',
    // Say plainly where the body is, rather than leaving a blank card that looks
    // like the drop failed. The shell replaces this within the second.
    notes: MAIL_BODY_PENDING,
    email: {
      ...emptyEmailMeta(),
      messageId: messageIdFromUrl(url),
      source: 'mail-drag',
    },
  };
}
