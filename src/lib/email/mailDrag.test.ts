import { describe, expect, it } from 'vitest';
import { mailUrlFor } from './mailDrag';

// The real payload, captured from Apple Mail on macOS: the URL Mail derives
// from a Message-ID — angle brackets encoded, everything else literal.
const REAL_URL =
  'message:%3C2109994232.321763.1597727103956.JavaMail.root@console-scheduler-2.private.netregistry.net%3E';
const REAL_ID =
  '<2109994232.321763.1597727103956.JavaMail.root@console-scheduler-2.private.netregistry.net>';

describe('mailUrlFor', () => {
  it('derives the URL Mail understands', () => {
    expect(mailUrlFor(REAL_ID)).toBe(REAL_URL);
  });

  it('leaves @ and . literal — only the brackets are encoded', () => {
    expect(mailUrlFor('<a.b@c-d.example>')).toBe('message:%3Ca.b@c-d.example%3E');
  });
});
