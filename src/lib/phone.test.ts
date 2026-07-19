import { describe, expect, it, beforeEach } from 'vitest';
import { normaliseNumber, formatNumber, setLocalCallingCode, getLocalCallingCode } from './phone';

describe('normaliseNumber', () => {
  beforeEach(() => setLocalCallingCode('+61'));

  it('folds a leading national 0 to the configured calling code', () => {
    expect(normaliseNumber('0403 123 456')).toBe('+61403123456');
    expect(normaliseNumber('02 9876 5432')).toBe('+61298765432');
  });

  it('keeps an already-international number', () => {
    expect(normaliseNumber('+61 403 123 456')).toBe('+61403123456');
    expect(normaliseNumber('+1 202 555 0134')).toBe('+12025550134');
  });

  it('treats a 00 prefix as international access', () => {
    expect(normaliseNumber('0061 403 123 456')).toBe('+61403123456');
  });

  it('folds a local and its international spelling to the same key, idempotently', () => {
    expect(normaliseNumber('0403123456')).toBe(normaliseNumber('+61 403 123 456'));
    expect(normaliseNumber(normaliseNumber('0403123456'))).toBe('+61403123456');
  });

  it('leaves a region-less number (no 0, no +) as bare digits', () => {
    expect(normaliseNumber('403 123 456')).toBe('403123456');
  });

  it('is empty when there are no digits', () => {
    expect(normaliseNumber('   ')).toBe('');
    expect(normaliseNumber('abc')).toBe('');
  });

  it('honours a different configured calling code', () => {
    setLocalCallingCode('+44');
    expect(normaliseNumber('07911 123456')).toBe('+447911123456');
  });

  it('normalises the configured code itself (61 → +61)', () => {
    setLocalCallingCode('61');
    expect(getLocalCallingCode()).toBe('+61');
    expect(normaliseNumber('0403123456')).toBe('+61403123456');
  });

  it('falls back to +61 for an empty code', () => {
    setLocalCallingCode('');
    expect(getLocalCallingCode()).toBe('+61');
  });
});

describe('formatNumber', () => {
  beforeEach(() => setLocalCallingCode('+61'));

  it('groups an AU mobile as +61 4XX XXX XXX', () => {
    expect(formatNumber('0403123456')).toBe('+61 403 123 456');
    expect(formatNumber('+61403123456')).toBe('+61 403 123 456');
  });

  it('groups an AU landline as +61 X XXXX XXXX', () => {
    expect(formatNumber('02 9876 5432')).toBe('+61 2 9876 5432');
  });

  it('leaves a foreign-coded number canonical rather than mis-splitting it', () => {
    expect(formatNumber('+1 202 555 0134')).toBe('+12025550134');
  });

  it('returns a region-less number as its digits', () => {
    expect(formatNumber('403123456')).toBe('403123456');
  });

  it('is empty for nothing', () => {
    expect(formatNumber('')).toBe('');
  });
});
