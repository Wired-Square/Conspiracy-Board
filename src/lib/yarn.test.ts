import { describe, expect, it } from 'vitest';
import { yarnPath } from './yarn';

describe('yarnPath', () => {
  it('hangs a cubic between the two ends, both controls sagging below the line', () => {
    expect(yarnPath(0, 0, 300, 0).path).toBe('M0,0 C100,36 200,36 300,0');
  });

  it('sags at least 16 and at most 90', () => {
    expect(yarnPath(0, 0, 10, 0).path).toBe(`M0,0 C${10 / 3},16 ${20 / 3},16 10,0`);
    expect(yarnPath(0, 0, 2000, 0).path).toBe(`M0,0 C${2000 / 3},90 ${4000 / 3},90 2000,0`);
  });

  it('puts the tag on the sagged midpoint', () => {
    expect(yarnPath(0, 0, 300, 100)).toMatchObject({ labelX: 150, labelY: 50 + Math.hypot(300, 100) * 0.12 * 0.75 });
  });
});
