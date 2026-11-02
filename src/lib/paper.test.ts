import { describe, expect, it } from 'vitest';
import { cardTilt, initials } from './paper';

describe('initials', () => {
  it('takes the first and last names', () => {
    expect(initials('Mhairi Fraser')).toBe('MF');
    expect(initials('Jean-Luc de la Croix')).toBe('JC');
  });

  it('takes one letter from a single word', () => {
    expect(initials('Siemens')).toBe('S');
    expect(initials('goulburn.nsw.gov.au')).toBe('G');
  });

  it('skips punctuation and empty names', () => {
    expect(initials("'Mark Fleming'")).toBe('MF');
    expect(initials('  ')).toBe('');
    expect(initials('— ?')).toBe('');
  });

  it('keeps accented letters', () => {
    expect(initials('élodie Ørsted')).toBe('ÉØ');
  });
});

describe('cardTilt', () => {
  it('is the same for one id and stays within a degree', () => {
    const ids = ['a', 'card-1', 'card-2', '01HZY3', 'x'.repeat(40)];
    for (const id of ids) {
      expect(cardTilt(id)).toBe(cardTilt(id));
      expect(Math.abs(cardTilt(id))).toBeLessThanOrEqual(1);
    }
  });

  it('varies between ids', () => {
    const tilts = new Set(Array.from({ length: 20 }, (_, i) => cardTilt(`card-${i}`)));
    expect(tilts.size).toBeGreaterThan(10);
  });
});
