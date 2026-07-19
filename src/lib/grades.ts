import type { CSSProperties } from 'react';
import type { Grade } from '../types/board';

// How good is this claim? Eight grades, a ladder rather than a "true/false"
// switch — most of what goes on a board is neither, and collapsing it to two
// values is how a board starts lying. REFUTED sits at the bottom, rare and
// load-bearing: it earns its place by being impossible to fake with a vaguer
// word like "Suspected".
//
// The definitions are the scale. The labels are one word each and one word is
// not enough to grade by — two people only grade the same claim the same way if
// they are reading the same sentence. So the definitions are not reference
// material to be filed behind a legend: they belong wherever a grade is being
// chosen (see GradeField), and wherever the board explains itself (see
// BoardPropertiesModal).
//
// This file is the whole visual language of a grade, not just its name. The
// colour is here, the ink that stays readable on it is computed here, and
// gradeTint below is the only way any of it reaches a stylesheet. Nothing about
// a grade is written down twice.

export type GradeMeta = {
  label: string;
  /** What the grade means. Verbatim — do not paraphrase these. */
  definition: string;
  colour: string;
};

/**
 * The eight, strongest first, ending with the one that says the record went the
 * other way. `Record<Grade, …>` makes a forgotten grade a compile error, which
 * is the point of keeping them here rather than inline in a picker.
 *
 * The colours keep the families the scale is published in — the greens of a
 * finding, amber for an allegation, violet for a read, grey for an open
 * question, red for a contradiction — but are pulled apart far enough to be told
 * apart at a glance, which is the only thing a colour on a board is for. Every
 * pair, including against the plain red string, clears ~28 CIE76 dE, and every
 * one takes a chip ink that clears WCAG AA.
 *
 * That last constraint is what shapes the greens. A mid-luminance colour is
 * unreadable under either ink, so the two dark greens cannot separate by
 * lightness alone: Adjudicated is deep and teal-leaning, Admitted deep and
 * grass, and only Confirmed is light. Retune one and re-check both distances —
 * the two pull against each other.
 */
export const GRADE_META: Record<Grade, GradeMeta> = {
  adjudicated: {
    label: 'Adjudicated',
    definition: 'Decided by a court or tribunal, on the record.',
    colour: '#0a5c4a',
  },
  admitted: {
    label: 'Admitted',
    definition: "Established by a party's own admission or a consent decree.",
    colour: '#187008',
  },
  confirmed: {
    label: 'Confirmed',
    definition: 'Established by a primary document or official record.',
    colour: '#9ade8f',
  },
  corroborated: {
    label: 'Corroborated',
    definition: 'Supported by multiple independent sources.',
    colour: '#4a90d9',
  },
  asserted: {
    label: 'Asserted',
    definition: 'Alleged or sworn, but not yet decided.',
    colour: '#d99a2b',
  },
  inference: {
    label: 'Inference',
    definition: 'A reasoned read of the record, not a direct finding.',
    // The derived layer dyes itself from this rather than carrying a violet of
    // its own: what the roster works out from an address *is* an inference, so
    // it is the same claim and must stay the same colour by construction.
    colour: '#a98bd8',
  },
  unresolved: {
    label: 'Unresolved',
    definition: 'Open, the record does not yet settle it.',
    colour: '#8a8578',
  },
  refuted: {
    label: 'Refuted',
    // Deliberately nothing like --string (#c8402f). An ungraded strand is
    // already red, so a brick-red REFUTED would be the most important link on
    // the board wearing the most ordinary colour on it.
    definition: 'Contradicted by the record.',
    colour: '#ff2e63',
  },
};

/** The eight in ladder order, for a picker, a legend, or a swatch list. */
export const GRADES = Object.keys(GRADE_META) as Grade[];

// Ink. Which of the board's two inks stays readable on a given grade is a fact
// about the colour, so it is worked out from the colour rather than written down
// beside it — a hand-kept list is one more thing to get out of step when a
// colour is tuned.

const INK_LIGHT = '#ece3d4';
const INK_DARK = '#221a10';

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Whichever ink contrasts better — so a colour can be tuned without a re-think. */
export function readableInk(colour: string): string {
  const l = luminance(colour);
  return contrast(l, luminance(INK_LIGHT)) >= contrast(l, luminance(INK_DARK))
    ? INK_LIGHT
    : INK_DARK;
}

/**
 * Dye something a grade. The chip, the select, the strand and the swatch all
 * take their colour this way, so the custom properties are spelled once and a
 * stylesheet never has to know a hex.
 */
export function gradeTint(grade: Grade): CSSProperties {
  const { colour } = GRADE_META[grade];
  return {
    ['--grade' as string]: colour,
    ['--grade-ink' as string]: readableInk(colour),
  };
}
