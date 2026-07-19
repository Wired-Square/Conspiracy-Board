import { describe, expect, it } from 'vitest';
import { looksLikeMbox, splitMbox } from './mbox';

// A From_ line is `From <sender> <ctime date>`; the fixtures mirror real files.
const msg = (from: string, subject: string, body: string) =>
  `From ${from} Mon Jan 1 00:00:00 2024\nFrom: ${from}\nSubject: ${subject}\n\n${body}\n`;

describe('looksLikeMbox', () => {
  it('recognises a From_ line at the start', () => {
    expect(looksLikeMbox('From a@b.com Mon Jan 1 00:00:00 2024\nFrom: a@b.com\n')).toBe(
      true,
    );
  });

  it('recognises the Google Takeout From_ format', () => {
    expect(
      looksLikeMbox('From 1798384@xxx Sat Nov 16 10:15:00 +0000 2024\nFrom: a@b.com\n'),
    ).toBe(true);
  });

  it('does not mistake a plain .eml for an mbox', () => {
    expect(looksLikeMbox('From: a@b.com\nSubject: hi\n\nbody')).toBe(false);
  });

  it('does not mistake prose starting with "From " for a From_ line', () => {
    expect(looksLikeMbox('From what I heard, the store was seized.')).toBe(false);
  });
});

describe('splitMbox', () => {
  it('splits multiple messages', () => {
    const box = msg('a@x.com', 'One', 'first') + '\n' + msg('b@x.com', 'Two', 'second');
    const out = splitMbox(box);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Subject: One');
    expect(out[1]).toContain('Subject: Two');
  });

  it('drops the From_ separator from the message body', () => {
    const out = splitMbox(msg('a@x.com', 'One', 'first'));
    expect(out[0].startsWith('From: a@x.com')).toBe(true);
  });

  it('does not split on a body line that merely starts with "From "', () => {
    // The naive /^From /m split fails exactly here.
    const box =
      'From a@x.com Mon Jan 1 00:00:00 2024\n' +
      'From: a@x.com\n' +
      'Subject: One\n' +
      '\n' +
      'Quoting them:\n' +
      'From what I heard, the store was seized.\n';
    const out = splitMbox(box);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('From what I heard');
  });

  it('keeps a body whose very first line starts with "From "', () => {
    // The header/body separator is a blank line, so the first body line is
    // always preceded by one — a blank-line guard alone would eat this body.
    const box =
      'From a@x.com Mon Jan 1 00:00:00 2024\n' +
      'From: a@x.com\n' +
      'Subject: One\n' +
      '\n' +
      'From what I heard, the store was seized.\n';
    const out = splitMbox(box);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('From what I heard');
  });

  it('unescapes mboxrd >From quoting', () => {
    const box =
      'From a@x.com Mon Jan 1 00:00:00 2024\n' +
      'From: a@x.com\n' +
      'Subject: One\n' +
      '\n' +
      '>From the top\n' +
      '>>From nested\n';
    const out = splitMbox(box)[0];
    expect(out).toContain('\nFrom the top');
    expect(out).toContain('\n>From nested');
  });

  it('returns no trailing empty message', () => {
    const box = msg('a@x.com', 'One', 'first') + '\n\n\n';
    expect(splitMbox(box)).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const box = msg('a@x.com', 'One', 'first').replace(/\n/g, '\r\n');
    const out = splitMbox(box);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Subject: One');
  });

  it('returns nothing for empty input', () => {
    expect(splitMbox('')).toEqual([]);
  });
});
