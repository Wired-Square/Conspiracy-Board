import { describe, expect, it } from 'vitest';
import { ocrTitle, usableOcr } from './ocr';

describe('usableOcr', () => {
  it('keeps recognised text that reads like captured writing', () => {
    expect(usableOcr('Yes! 3pm at the cafe on King St.')).toBe(true);
    expect(usableOcr('Hey are we\nstill on for tomorrow')).toBe(true);
  });

  it('rejects a stray fragment or a photo with no real text', () => {
    expect(usableOcr('')).toBe(false);
    expect(usableOcr('   \n  ')).toBe(false);
    expect(usableOcr('STOP')).toBe(false); // one word off a sign
    expect(usableOcr('Main St')).toBe(false); // two short words
  });
});

describe('ocrTitle', () => {
  it('takes the first non-empty line', () => {
    expect(ocrTitle('  \nHey there\nsecond line')).toBe('Hey there');
  });

  it('caps a long first line with an ellipsis', () => {
    const long = 'a'.repeat(80);
    const title = ocrTitle(long);
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('is empty when there is nothing to read', () => {
    expect(ocrTitle('')).toBe('');
  });
});
