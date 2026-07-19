import { describe, expect, it } from 'vitest';
import { parseEmailFile, parseEmailText } from './parseEmails';

// Covers the header→Card mapping and the postal-mime integration on the paths
// that need no DOM. HTML bodies go through DOMParser and are verified in the
// browser instead; see htmlToText.

const encode = (s: string): ArrayBuffer => {
  const b = new TextEncoder().encode(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const EML = [
  'From: "Sable, Dominic" <dutch@bluecanary.example>',
  'To: consignor@example.com, "Doe, Jane" <jane@example.com>',
  'Cc: legal@bluecanary.example',
  // RFC 2047 encoded-word — a naive parser leaves this as mojibake.
  'Subject: =?UTF-8?Q?Re=3A_the_=E2=80=9Ccollection=E2=80=9D?=',
  'Date: Thu, 14 Nov 2024 17:32:11 -0800',
  'Message-ID: <abc123@bluecanary.example>',
  'In-Reply-To: <prev999@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Per our call =E2=80=94 the collection was moved.',
  '',
].join('\r\n');

const MBOX = [
  'From dutch@x.example Thu Nov 14 17:32:11 2024',
  'From: dutch@x.example',
  'Subject: First message',
  'Date: Thu, 14 Nov 2024 17:32:11 -0800',
  'Message-ID: <m1@x.example>',
  '',
  'Body of the first.',
  '>From the top, this line was escaped.',
  '',
  'From jane@x.example Fri Nov 15 08:00:00 2024',
  'From: jane@x.example',
  'Subject: Second message',
  'Date: Fri, 15 Nov 2024 08:00:00 +0000',
  'Message-ID: <m2@x.example>',
  '',
  'From what I heard, this must not split the message.',
  '',
].join('\n');

describe('parseEmailFile — .eml', () => {
  it('maps the headers onto card fields', async () => {
    const { drafts, errors } = await parseEmailFile('sample.eml', encode(EML));
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);

    const d = drafts[0];
    expect(d.kind).toBe('email');
    // Encoded-word subject decoded, and it becomes the title (not email.subject).
    expect(d.title).toBe('Re: the “collection”');
    expect(d.email.from).toEqual({ name: 'Sable, Dominic', address: 'dutch@bluecanary.example' });
    expect(d.email.to).toHaveLength(2);
    expect(d.email.cc).toEqual([{ address: 'legal@bluecanary.example' }]);
    expect(d.email.messageId).toBe('<abc123@bluecanary.example>');
    expect(d.email.inReplyTo).toBe('<prev999@example.com>');
  });

  it('normalises the Date header offset to a UTC instant', async () => {
    const { drafts } = await parseEmailFile('sample.eml', encode(EML));
    // 17:32:11 -0800 is 01:32:11Z the next day. The instant must survive; only
    // the authored offset is discarded.
    expect(drafts[0].occurredAt).toBe('2024-11-15T01:32:11.000Z');
    expect(drafts[0].occurredAtPrecision).toBe('minute');
  });

  it('decodes a quoted-printable body into notes', async () => {
    const { drafts } = await parseEmailFile('sample.eml', encode(EML));
    expect(drafts[0].notes).toContain('Per our call — the collection was moved.');
  });

  it('imports a message with no Date as undated rather than dropping it', async () => {
    const noDate = 'From: a@x.example\nSubject: No date\n\nbody\n';
    const { drafts, errors } = await parseEmailFile('nodate.eml', encode(noDate));
    expect(errors).toEqual([]);
    expect(drafts[0].occurredAt).toBeNull();
    expect(drafts[0].title).toBe('No date');
  });

  it('falls back to a placeholder title when there is no subject', async () => {
    const noSubject = 'From: a@x.example\n\nbody\n';
    const { drafts } = await parseEmailFile('nosubj.eml', encode(noSubject));
    expect(drafts[0].title).toBe('(no subject)');
  });
});

describe('parseEmailFile — .mbox', () => {
  it('splits into one draft per message', async () => {
    const { drafts, errors } = await parseEmailFile('sample.mbox', encode(MBOX));
    expect(errors).toEqual([]);
    expect(drafts.map((d) => d.title)).toEqual(['First message', 'Second message']);
    expect(drafts.map((d) => d.email.messageId)).toEqual(['<m1@x.example>', '<m2@x.example>']);
  });

  it('does not split on a body line starting with "From "', async () => {
    const { drafts } = await parseEmailFile('sample.mbox', encode(MBOX));
    expect(drafts[1].notes).toContain('From what I heard');
  });

  it('unescapes mboxrd >From quoting in the body', async () => {
    const { drafts } = await parseEmailFile('sample.mbox', encode(MBOX));
    expect(drafts[0].notes).toContain('From the top');
    expect(drafts[0].notes).not.toContain('>From the top');
  });

  it('sniffs an mbox regardless of its extension', async () => {
    const { drafts } = await parseEmailFile('export.txt', encode(MBOX));
    expect(drafts).toHaveLength(2);
  });
});

const b64 = (s: string): string => btoa(s);

// multipart/mixed carrying: a binary attachment, a text attachment (which the
// parser hands back as a string), an inline cid logo, and a real image.
const MULTIPART = [
  'From: sender@x.example',
  'To: rcpt@x.example',
  'Subject: With attachments',
  'Date: Thu, 14 Nov 2024 17:32:11 -0800',
  'Message-ID: <mp1@x.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello body',
  '',
  '--BOUND',
  'Content-Type: application/pdf; name="contract.pdf"',
  'Content-Disposition: attachment; filename="contract.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('pretend-pdf-bytes'),
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  '',
  'a plain text note',
  '',
  '--BOUND',
  'Content-Type: image/png',
  'Content-Disposition: inline',
  'Content-ID: <logo>',
  'Content-Transfer-Encoding: base64',
  '',
  b64('pretend-logo-png'),
  '',
  '--BOUND',
  'Content-Type: image/png; name="photo.png"',
  'Content-Disposition: attachment; filename="photo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('pretend-photo-png'),
  '',
  '--BOUND--',
  '',
].join('\r\n');

describe('parseEmailFile — attachments', () => {
  it('keeps real attachments, dropping inline layout images', async () => {
    const { drafts, errors } = await parseEmailFile('mp.eml', encode(MULTIPART));
    expect(errors).toEqual([]);
    // The inline cid logo is layout, not a document; photo.png becomes the
    // picture, so the list is the two genuine attachments only.
    expect(drafts[0].media.attachments.map((a) => a.name)).toEqual(['contract.pdf', 'notes.txt']);
  });

  it('files every attachment, including a text part the parser gives as a string', async () => {
    const { drafts } = await parseEmailFile('mp.eml', encode(MULTIPART));
    const bytesByName = new Map(drafts[0].media.attachments.map((a) => [a.name, a.bytes]));
    expect(bytesByName.get('contract.pdf')).toBeInstanceOf(ArrayBuffer);
    // The regression this guards: a string-content part used to lose its bytes.
    expect(bytesByName.get('notes.txt')).toBeInstanceOf(ArrayBuffer);
  });

  it('promotes the first real image to the picture, not an inline logo', async () => {
    const { drafts } = await parseEmailFile('mp.eml', encode(MULTIPART));
    expect(drafts[0].media.image?.ext).toBe('png');
    expect(drafts[0].media.image?.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it('lists only the real attachments in the notes summary', async () => {
    const { drafts } = await parseEmailFile('mp.eml', encode(MULTIPART));
    expect(drafts[0].notes).toContain('**Attachments:** contract.pdf, notes.txt');
  });
});

// Apple Mail attaches documents as `Content-Disposition: inline` (so they preview
// in the message pane) with a filename and no Content-ID — the exact shape that a
// disposition-based inline filter wrongly discarded.
const APPLE_MAIL_INLINE = [
  'From: sender@x.example',
  'To: rcpt@x.example',
  'Subject: With an inline PDF',
  'Date: Thu, 14 Nov 2024 17:32:11 -0800',
  'Message-ID: <apple1@x.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See attached.',
  '',
  '--BOUND',
  'Content-Disposition: inline; filename="report.pdf"',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('pretend-pdf-bytes'),
  '',
  '--BOUND--',
  '',
].join('\r\n');

describe('parseEmailFile — Apple Mail inline attachments', () => {
  it('keeps an inline-disposition document that carries a filename and no Content-ID', async () => {
    const { drafts, errors } = await parseEmailFile('apple.eml', encode(APPLE_MAIL_INLINE));
    expect(errors).toEqual([]);
    // The regression: `disposition === 'inline'` used to drop this, losing the file.
    expect(drafts[0].media.attachments.map((a) => a.name)).toEqual(['report.pdf']);
    expect(drafts[0].media.attachments[0].bytes).toBeInstanceOf(ArrayBuffer);
  });
});

describe('parseEmailText', () => {
  it('parses a pasted raw message', async () => {
    const { drafts, errors } = await parseEmailText(EML);
    expect(errors).toEqual([]);
    expect(drafts[0].title).toBe('Re: the “collection”');
  });

  it('reports an error for empty input rather than throwing', async () => {
    const { drafts, errors } = await parseEmailText('   ');
    expect(drafts).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
