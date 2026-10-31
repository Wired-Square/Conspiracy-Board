import { describe, expect, it } from 'vitest';
import { documentFacts, imageFacts } from './mediaFacts';

describe('imageFacts', () => {
  it('lists only what the photo carries', () => {
    expect(imageFacts({ width: 4000, height: 3000, cameraMake: 'Apple', cameraModel: 'iPhone', latitude: -33.8688, longitude: 151.2093 })).toEqual([
      ['Size', '4000 × 3000'],
      ['Camera', 'Apple iPhone'],
      ['Location', '-33.86880, 151.20930'],
    ]);
    expect(imageFacts({})).toEqual([]);
  });
});

describe('documentFacts', () => {
  it('keeps a zero page count and skips what is missing', () => {
    expect(documentFacts({ author: 'Ada', pages: 0, words: 1200 })).toEqual([
      ['Author', 'Ada'],
      ['Pages', '0'],
      ['Words', '1,200'],
    ]);
  });
});
