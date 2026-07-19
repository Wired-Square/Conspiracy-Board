import { describe, expect, it } from 'vitest';
import {
  MAIL_BODY_PENDING,
  mailUrlFor,
  messageIdFromUrl,
  readMailDrop,
} from './mailDrag';

// The real payload, captured from Apple Mail → Chrome on macOS.
const REAL_URL =
  'message:%3C2109994232.321763.1597727103956.JavaMail.root@console-scheduler-2.private.netregistry.net%3E';
const REAL_ID =
  '<2109994232.321763.1597727103956.JavaMail.root@console-scheduler-2.private.netregistry.net>';
const REAL_SUBJECT = 'TPP Wholesale Pty Ltd Invoice No: 14900663';

describe('messageIdFromUrl', () => {
  it('decodes a real Apple Mail message: URL', () => {
    expect(messageIdFromUrl(REAL_URL)).toBe(REAL_ID);
  });

  it('produces the same form the MIME parser stores, so the two can match', () => {
    // Angle brackets included, no percent-encoding. This identity is what lets a
    // later .eml import recognise the reference card.
    const id = messageIdFromUrl(REAL_URL)!;
    expect(id).toMatch(/^<.+>$/);
    expect(id).not.toContain('%');
  });

  it('tolerates the message:// spelling and any scheme casing', () => {
    expect(messageIdFromUrl('message://%3Cabc@host%3E')).toBe('<abc@host>');
    expect(messageIdFromUrl('MESSAGE:%3Cabc@host%3E')).toBe('<abc@host>');
  });

  it('returns null for a non-message URL', () => {
    expect(messageIdFromUrl('https://example.com')).toBeNull();
    expect(messageIdFromUrl('')).toBeNull();
    expect(messageIdFromUrl('message:')).toBeNull();
  });

  it('returns null when the id is not bracketed', () => {
    // Not an RFC 5322 Message-ID; storing it would invent false dedupe matches.
    expect(messageIdFromUrl('message:abc@host')).toBeNull();
    expect(messageIdFromUrl('message:%3C%3E')).toBeNull();
  });

  it('returns null on malformed percent-escapes rather than throwing', () => {
    expect(messageIdFromUrl('message:%E0%A4%A')).toBeNull();
  });
});

describe('mailUrlFor', () => {
  it('rebuilds exactly the URL Apple Mail produced', () => {
    // The whole reason the link can be derived instead of stored.
    expect(mailUrlFor(REAL_ID)).toBe(REAL_URL);
  });

  it('round-trips through messageIdFromUrl', () => {
    expect(messageIdFromUrl(mailUrlFor(REAL_ID))).toBe(REAL_ID);
  });

  it('encodes only the angle brackets, leaving @ and . alone', () => {
    // encodeURIComponent would escape @ to %40 and not match what Mail emits.
    expect(mailUrlFor('<a.b@c-d.example>')).toBe('message:%3Ca.b@c-d.example%3E');
  });
});

describe('readMailDrop', () => {
  it('turns the real Apple Mail drag into an email card', () => {
    const card = readMailDrop(REAL_URL, REAL_SUBJECT)!;
    expect(card.kind).toBe('email');
    expect(card.title).toBe(REAL_SUBJECT);
    expect(card.email?.messageId).toBe(REAL_ID);
  });

  it('records its provenance, so a later import knows to fill it in', () => {
    // Recorded rather than inferred from empty fields: a real message with no
    // From and no Date must not be mistaken for one of these.
    expect(readMailDrop(REAL_URL, REAL_SUBJECT)!.email?.source).toBe('mail-drag');
  });

  it('says the body is on its way rather than leaving a blank card', () => {
    // The shell is already fetching it from Mail's file promise, so telling the
    // user to import the .eml themselves would be wrong — and this note is about
    // to be replaced out from under them anyway.
    expect(readMailDrop(REAL_URL, REAL_SUBJECT)!.notes).toBe(MAIL_BODY_PENDING);
  });

  it('leaves the card undated — Mail gives us no date', () => {
    expect(readMailDrop(REAL_URL, REAL_SUBJECT)!.occurredAt).toBeUndefined();
  });

  it('ignores drags that are not from Mail', () => {
    expect(readMailDrop('https://example.com/page', 'Some page')).toBeNull();
    expect(readMailDrop('', '')).toBeNull();
  });

  it('picks the message URL out of a multi-line uri-list', () => {
    const list = `# comment\r\nhttps://example.com\r\n${REAL_URL}\r\n`;
    expect(readMailDrop(list, REAL_SUBJECT)?.email?.messageId).toBe(REAL_ID);
  });

  it('falls back to a placeholder title when Mail sends no subject', () => {
    expect(readMailDrop(REAL_URL, '')!.title).toBe('(no subject)');
  });

  it('still makes a card when the id is unusable, just without one', () => {
    const card = readMailDrop('message:not-bracketed', 'Subject')!;
    expect(card.kind).toBe('email');
    expect(card.email?.messageId).toBeNull();
  });
});
