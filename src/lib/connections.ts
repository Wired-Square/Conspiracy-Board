/**
 * A piece of string, by its two ends only.
 *
 * A connection has a source and a target because it has to be drawn from
 * somewhere to somewhere — not because the claim it carries has a direction.
 * Every question worth asking of it is therefore direction-blind, and forgetting
 * that is a one-character bug (`===` on the wrong end) that hides until the day
 * a card is deleted from the far side. So the comparison is written once, in
 * `otherEnd`, and everything else is asked through it.
 *
 * Structural rather than `Connection`, so a stored connection and a rendered
 * edge both satisfy it — the same trick lib/roster.ts uses.
 */
type Link = { source: string; target: string };

/**
 * The card at the far end of a piece of string, or null if it is not tied to
 * this one at all. The one place source/target is compared against an id.
 */
export function otherEnd(link: Link, cardId: string): string | null {
  if (link.source === cardId) return link.target;
  if (link.target === cardId) return link.source;
  return null;
}

/**
 * Whether a piece of string is tied to this card, at either end.
 *
 * Named because several things ask it and must agree: the editor lists a card's
 * string, deleting a card takes that string with it, the confirm counts it first
 * so nobody loses a link they had forgotten was there, and the canvas dims what
 * the focused card is not tied to.
 */
export function touches(link: Link, cardId: string): boolean {
  return otherEnd(link, cardId) !== null;
}
