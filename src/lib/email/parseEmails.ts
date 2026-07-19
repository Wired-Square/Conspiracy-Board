import type { Card, EmailAddress } from '../../types/board';
import { htmlToPlainText } from './htmlToText';
import { looksLikeMbox, splitMbox } from './mbox';
import { extOf } from '../../storage/media';

/**
 * Transient bytes a parsed message carries until it is committed. Never stored
 * on a Card: `persistDraftMedia` writes these to the media library and strips
 * them, leaving `imageFile` / `attachments[].file` / `emlFile` behind. Parsing
 * does no IO, so a message the user previews but never adds costs no disk.
 */
export type DraftMedia = {
  /** The card's picture: the first image the message carried, if any. */
  image?: { bytes: ArrayBuffer; ext: string };
  /** Every other attachment, with bytes where the parser gave us them. */
  attachments: { name: string; ext: string; mime?: string; bytes?: ArrayBuffer }[];
  /** The whole original message, to keep as its .eml. */
  eml?: ArrayBuffer;
};

/** A parsed message, shaped as the fields of the Card it will become. */
export type EmailDraft = Pick<
  Card,
  'title' | 'notes' | 'occurredAt' | 'occurredAtPrecision'
> & { kind: 'email'; email: NonNullable<Card['email']>; media: DraftMedia };

export type ParseResult = { drafts: EmailDraft[]; errors: string[] };

// The notes cap outlived the localStorage budget that first set it: a board is a
// file now and there is no quota. It stays because autosave rewrites the whole
// board file 500ms after every edit, so the notes' size is paid again on each
// one — and because a card is a note on a corkboard, not an archive of the
// message, which is now kept whole as its .eml alongside. The image is no longer
// capped: it is a file on disk, not base64 re-serialised on every save.

/** Marketing mail routinely carries 200KB of inlined CSS. */
const MAX_NOTES = 20_000;

type PostalAddress = { name?: string; address?: string };

function toAddress(a: PostalAddress | undefined): EmailAddress | null {
  if (!a?.address) return null;
  const name = a.name?.trim();
  return name ? { name, address: a.address } : { address: a.address };
}

function toAddressList(list: PostalAddress[] | undefined): EmailAddress[] {
  return (list ?? [])
    .map(toAddress)
    .filter((a): a is EmailAddress => a !== null);
}

/** The postal-mime attachment fields this file reads. Declared rather than
 *  imported: PostalMime is loaded dynamically, to keep it out of the bundle. */
type PostalAttachment = {
  filename?: string | null;
  mimeType?: string;
  disposition?: 'attachment' | 'inline' | null;
  related?: boolean;
  contentId?: string;
  content: ArrayBuffer | Uint8Array | string;
};

/**
 * Content as bytes, whatever shape the parser handed us: an ArrayBuffer as is, a
 * Uint8Array unwrapped, a string (a text attachment, or an mbox slice) encoded
 * UTF-8 — best effort, since a decoded string has already lost its charset.
 * Undefined only when there is no content at all.
 */
function contentToBytes(
  content: ArrayBuffer | Uint8Array | string | null | undefined,
): ArrayBuffer | undefined {
  if (content == null) return undefined;
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
  }
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}

/** The message's own bytes, to keep as its .eml. Always present, so never null. */
function rawToBytes(raw: string | ArrayBuffer): ArrayBuffer {
  return contentToBytes(raw)!;
}

/** An inline part is layout, not a document: a signature logo, a tracking pixel,
 *  or an image the HTML body references by cid. Such a part rides in a
 *  multipart/related group (`related`) or carries a Content-ID. Disposition is not
 *  the signal it looks like: Apple Mail marks genuine attachments — a PDF, a Word
 *  document — `Content-Disposition: inline` so they preview in the message, so
 *  keying off `inline` drops the very files the user attached. Only real
 *  attachments are kept. */
function isInlinePart(a: PostalAttachment): boolean {
  return a.related === true || !!a.contentId;
}

function truncate(text: string): string {
  return text.length > MAX_NOTES
    ? `${text.slice(0, MAX_NOTES)}\n\n_[truncated]_`
    : text;
}

async function parseOne(raw: string | ArrayBuffer): Promise<EmailDraft> {
  // Dynamic so the MIME parser stays out of the initial bundle, matching how
  // boardStore lazy-loads the default board.
  const { default: PostalMime } = await import('postal-mime');
  const msg = await PostalMime.parse(raw);

  // A message with no usable Date is still worth importing — it just lands as
  // undated rather than being silently dropped.
  const parsedDate = msg.date ? new Date(msg.date) : null;
  const occurredAt =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : null;

  const body = msg.text?.trim()
    ? msg.text
    : msg.html
      ? htmlToPlainText(msg.html)
      : '';

  const attachments: PostalAttachment[] = msg.attachments ?? [];
  // Inline parts — a signature logo, a tracking pixel, an image the HTML body
  // references by cid — are layout, not documents. Keeping them out of both the
  // picture and the list stops a newsletter's furniture becoming attachments.
  const real = attachments.filter((a) => !isInlinePart(a));
  // The card's picture: the first real image the message carried. No size cap now
  // — it becomes a file, not base64 rewritten into the board on every autosave.
  const picture = real.find(
    (a) => a.mimeType?.startsWith('image/') && contentToBytes(a.content) !== undefined,
  );
  // Everything else stays an attachment, keeping its bytes whatever shape the
  // parser gave them: a text part arrives as a string, which we now file too.
  const rest = real
    .filter((a) => a !== picture)
    .map((a, i) => ({
      name: a.filename?.trim() || `attachment-${i + 1}`,
      mime: a.mimeType ?? undefined,
      bytes: contentToBytes(a.content),
    }));

  const notes = truncate(
    rest.length ? `${body}\n\n**Attachments:** ${rest.map((a) => a.name).join(', ')}` : body,
  );

  const media: DraftMedia = {
    image: picture
      ? { bytes: contentToBytes(picture.content)!, ext: extOf(picture.filename ?? undefined, picture.mimeType) }
      : undefined,
    attachments: rest.map((a) => ({
      name: a.name,
      ext: extOf(a.name, a.mime),
      mime: a.mime,
      bytes: a.bytes,
    })),
    eml: rawToBytes(raw),
  };

  return {
    title: msg.subject?.trim() || '(no subject)',
    notes,
    occurredAt,
    occurredAtPrecision: 'minute',
    kind: 'email',
    email: {
      from: toAddress(msg.from),
      to: toAddressList(msg.to),
      cc: toAddressList(msg.cc),
      messageId: msg.messageId?.trim() || null,
      inReplyTo: msg.inReplyTo?.trim() || null,
      // Filled at commit by persistDraftMedia, from media.attachments (name +
      // the file its bytes were saved to). The names for the notes summary are
      // taken from `rest` above, so nothing here needs them yet.
      attachments: [],
    },
    media,
  };
}

/** Parse many raw messages, collecting per-message failures rather than
 *  throwing — one bad message must not lose the rest of an mbox. */
async function parseMany(
  raws: string[],
  label: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ParseResult> {
  const drafts: EmailDraft[] = [];
  const errors: string[] = [];

  for (const [i, raw] of raws.entries()) {
    try {
      drafts.push(await parseOne(raw));
    } catch (err) {
      errors.push(
        `${label}: message ${i + 1} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    onProgress?.(i + 1, raws.length);
  }
  return { drafts, errors };
}

/**
 * Parse a dropped or picked file. Takes bytes, not text: `file.text()` assumes
 * UTF-8 and would mojibake mail that declares another charset — the parser can
 * only apply the declared charset if it still has the original bytes.
 */
export async function parseEmailFile(
  name: string,
  bytes: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<ParseResult> {
  // Sniff rather than trust the extension — a dragged mbox may be named .txt.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.slice(0, 1024),
  );

  if (looksLikeMbox(head) || name.toLowerCase().endsWith('.mbox')) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return parseMany(splitMbox(text), name, onProgress);
  }

  try {
    const draft = await parseOne(bytes);
    onProgress?.(1, 1);
    return { drafts: [draft], errors: [] };
  } catch (err) {
    return {
      drafts: [],
      errors: [`${name} — ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** Parse pasted raw text (headers + body). Also copes with a pasted mbox. */
export async function parseEmailText(
  raw: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ParseResult> {
  const text = raw.trim();
  if (!text) return { drafts: [], errors: ['Nothing to parse.'] };

  const raws = looksLikeMbox(text) ? splitMbox(text) : [text];
  return parseMany(raws, 'Pasted text', onProgress);
}
