import { describe, expect, it } from 'vitest';
import { slugify } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('The Nightingale File')).toBe('the-nightingale-file');
  });

  it('collapses runs of punctuation into one hyphen', () => {
    expect(slugify('Who?! What --- Why…')).toBe('who-what-why');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  — hello —  ')).toBe('hello');
  });

  it('keeps the base letter of an accented character', () => {
    expect(slugify('Café Zürich')).toBe('cafe-zurich');
  });

  it('falls back to "board" when nothing survives', () => {
    expect(slugify('')).toBe('board');
    expect(slugify('   ')).toBe('board');
    expect(slugify('!!!')).toBe('board');
    expect(slugify('日本語')).toBe('board');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(80));
    expect(slug).toHaveLength(50);

    // A cap landing exactly on a separator must not leave a dangling dash.
    const onBoundary = slugify(`${'a'.repeat(50)} tail`);
    expect(onBoundary).toBe('a'.repeat(50));
    expect(onBoundary.endsWith('-')).toBe(false);
  });
});
