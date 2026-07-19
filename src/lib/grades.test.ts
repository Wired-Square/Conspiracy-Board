import { describe, expect, it } from 'vitest';
// The stylesheet itself, so the string's colour is never copied into this file:
// a test that duplicates the value it guards is the drift it exists to catch.
import css from '../index.css?raw';
import { GRADES, GRADE_META, gradeTint, readableInk } from './grades';

// The palette carries two promises that are easy to make and easy to break by
// nudging one hex: every chip stays readable, and no two grades — nor a grade and
// the plain red string — look alike. Both are arithmetic, so they are pinned here
// rather than left to whoever next tunes a colour to remember.

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** CIE76 ΔE — crude next to CIEDE2000, and far more than enough to catch a clash. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const X = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const Y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const Z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** The ungraded strand's colour, read from the stylesheet so this cannot drift. */
function stringColour(): string {
  const found = /--string:\s*(#[0-9a-f]{6})/i.exec(css);
  if (!found) throw new Error('--string not found in index.css');
  return found[1];
}

describe('GRADE_META', () => {
  it('has all eight, ladder order, strongest first', () => {
    expect(GRADES).toEqual([
      'adjudicated',
      'admitted',
      'confirmed',
      'corroborated',
      'asserted',
      'inference',
      'unresolved',
      'refuted',
    ]);
  });

  it('gives every grade a definition — the definitions are the scale', () => {
    for (const g of GRADES) {
      // A one-word label is not enough to grade by; a sentence is the point.
      expect(GRADE_META[g].definition.length).toBeGreaterThan(20);
      expect(GRADE_META[g].definition.endsWith('.')).toBe(true);
    }
  });

  it('gives every grade a six-digit hex colour', () => {
    for (const g of GRADES) expect(GRADE_META[g].colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('readableInk', () => {
  it('keeps every chip at WCAG AA against its own colour', () => {
    for (const g of GRADES) {
      const { colour } = GRADE_META[g];
      expect(contrast(colour, readableInk(colour))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks the darker ink on a light colour and the lighter on a dark one', () => {
    expect(readableInk('#ffffff')).toBe('#221a10');
    expect(readableInk('#000000')).toBe('#ece3d4');
  });
});

describe('the palette is distinct', () => {
  // Below ~25 the two stop being tellable apart at a glance, which is the only
  // thing a colour on a board is for.
  const FLOOR = 25;

  it('separates every pair of grades', () => {
    for (const a of GRADES) {
      for (const b of GRADES) {
        if (a >= b) continue;
        const d = deltaE(GRADE_META[a].colour, GRADE_META[b].colour);
        expect(d, `${a} vs ${b} are too close (ΔE ${d.toFixed(1)})`).toBeGreaterThan(FLOOR);
      }
    }
  });

  it('separates every grade from plain red string', () => {
    // Refuted is the one this is really for: an ungraded strand is already red,
    // so a brick-red REFUTED would be the most important link on a board wearing
    // the most ordinary colour on it.
    const string = stringColour();
    for (const g of GRADES) {
      const d = deltaE(GRADE_META[g].colour, string);
      expect(d, `${g} is too close to --string (ΔE ${d.toFixed(1)})`).toBeGreaterThan(FLOOR);
    }
  });
});

describe('gradeTint', () => {
  it('hands down both the colour and an ink that reads on it', () => {
    expect(gradeTint('refuted')).toEqual({
      '--grade': GRADE_META.refuted.colour,
      '--grade-ink': readableInk(GRADE_META.refuted.colour),
    });
  });
});
