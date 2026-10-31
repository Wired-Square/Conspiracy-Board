import type { Card } from '../../types/board';
import { size, count } from '@wired-square/kit/core';
import { matchDraft, type DraftMatch } from './meta';
import type { EmailDraft } from '../../bindings/EmailDraft';

// What the email import modal says before it commits: the counts, the button's
// label and the status line, and the name of the cluster a thread makes.

/** How many messages one import adds; the preview and the offer are built for a thread
 *  or a folder, not a whole mailbox. */
export const MAX_MESSAGES = 200;

/**
 * How many rows the offer shows before it stops, mirroring the errors list. A
 * 200-message mbox can carry 300 addresses, and the offer is for the handful the
 * user came for — one careless pass down a list that long would carpet the board
 * with newsletters, and there is no card deletion to take it back with.
 */
const MAX_OFFERED = 50;

/** A list the offer had to cut short, and the length it would have been. */
export type Capped<T> = { shown: T[]; total: number };

export function cap<T>(list: T[]): Capped<T> {
  return { shown: list.slice(0, MAX_OFFERED), total: list.length };
}

export function hidden(c: Capped<unknown>): number {
  return c.total - c.shown.length;
}

// There was a 2MB cap here, to stop one import filling the ~5MB localStorage
// budget. Boards are files now (see src/storage), so there is no budget to fill
// and nothing to refuse. The size is still worth showing — it is the user's disk
// — but it is information, not a limit.
export type BatchMatches = {
  matches: DraftMatch[];
  dupeCount: number;
  completesCount: number;
  addedBytes: number;
};

/** What each draft will do — the same rules addCards applies, so what's promised is what lands. */
export function matchBatch(drafts: EmailDraft[], byMessageId: Map<string, Card>): BatchMatches {
  const matches = drafts.map((d) => matchDraft(d, byMessageId));
  let dupeCount = 0;
  let completesCount = 0;
  let addedBytes = 0;
  matches.forEach((m, i) => {
    if (m.kind === 'duplicate') dupeCount++;
    else {
      if (m.kind === 'completes') completesCount++;
      addedBytes += drafts[i].bytes;
    }
  });
  return { matches, dupeCount, completesCount, addedBytes };
}

/**
 * A name for the cluster a dragged thread makes: the subject the batch shares,
 * with any `Re:`/`Fwd:` chain stripped, or a plain fallback when they disagree.
 */
export function clusterLabelFor(drafts: EmailDraft[]): string {
  // Strip a whole Re:/Fwd: chain in one pass — `\s*` eats the gaps, `+` the repeats.
  const bareSubject = (raw: string): string =>
    raw.trim().replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/i, '').trim();
  const counts = new Map<string, number>();
  for (const d of drafts) {
    const s = bareSubject(d.title);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = '';
  let top = 0;
  for (const [s, n] of counts) {
    if (n > top) [best, top] = [s, n];
  }
  return best || 'Email thread';
}

export type BatchCounts = {
  /** Messages that will make or complete a card. */
  newCount: number;
  newPeople: number;
  newOrgs: number;
  /** Existing cards the offer appends to. */
  patchCount: number;
  /** Duplicates moved into the chosen cluster. */
  reclusterCount: number;
};

/**
 * What the button will do, said out loud. A row aimed at a card that already
 * exists adds nothing, so when those are all there is, it stops saying Add
 * rather than offering to add none.
 */
export function addLabel({ newCount, newPeople, newOrgs, patchCount, reclusterCount }: BatchCounts): string {
  // "3 people, 1 organisation" — what the offer is about to mint.
  const entityBits = [
    newPeople > 0 && count(newPeople, 'person', 'people'),
    newOrgs > 0 && count(newOrgs, 'organisation'),
  ]
    .filter(Boolean)
    .join(', ');
  const addBits = [newCount > 0 && count(newCount, 'card'), entityBits].filter(Boolean).join(' + ');
  if (addBits) return `Add ${addBits}`;
  if (patchCount) return `Update ${count(patchCount, 'card')}`;
  if (reclusterCount) return `Add ${count(reclusterCount, 'card')} to cluster`;
  return 'Add 0 cards';
}

/** The footer's summary of a parsed batch. */
export function batchStatus(
  { dupeCount, completesCount, addedBytes }: BatchMatches,
  newCount: number,
  patchCount: number,
  willCluster: boolean,
): string {
  return [
    `${newCount} to add`,
    completesCount && `${completesCount} fills in a dragged message`,
    dupeCount && (willCluster ? `${dupeCount} added to cluster` : `${dupeCount} already on board`),
    patchCount && `${count(patchCount, 'existing card')} updated`,
    `~${size(addedBytes)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
