import { describe, expect, it } from 'vitest';
import { actorScale } from './layout';

describe('actorScale', () => {
  it('leaves a loner at exactly 1', () => {
    expect(actorScale(0)).toBe(1);
  });

  it('grows sub-linearly — the tenth string matters less than the first', () => {
    const first = actorScale(1) - actorScale(0);
    const tenth = actorScale(10) - actorScale(9);
    expect(actorScale(1)).toBeGreaterThan(1);
    expect(tenth).toBeLessThan(first);
  });

  it('never grows past the cap, however connected', () => {
    expect(actorScale(1000)).toBe(1.5);
  });

  it('is monotonic over realistic degrees', () => {
    for (let n = 1; n <= 60; n++) {
      expect(actorScale(n)).toBeGreaterThanOrEqual(actorScale(n - 1));
    }
  });
});
