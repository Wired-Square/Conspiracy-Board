import { z } from 'zod';
import type { Board } from '../types/board';

// The board library's index. Boards themselves are stored one per key/file and
// keep their own unchanged `Board` shape — the id lives here rather than inside
// a Board, so the board file format (and every previously exported file) stays
// exactly as it was.
//
// Entries are denormalised on purpose: listing boards must not parse every board
// body, since boards carry base64 images and can be megabytes. Drift is avoided
// by construction — the summary is always *derived* from `board.meta` at save
// time and never supplied by a caller.

export type BoardSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type BoardIndex = {
  version: 1;
  /** The board to reopen on load. Null only before the first board exists. */
  currentId: string | null;
  entries: BoardSummary[];
};

const boardSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});

export const boardIndexSchema = z.object({
  version: z.literal(1),
  currentId: z.string().nullable().default(null),
  entries: z.array(boardSummarySchema).default([]),
});

/** Non-throwing parse; null on anything unusable, which triggers a rebuild. */
export function safeParseBoardIndex(input: unknown): BoardIndex | null {
  const result = boardIndexSchema.safeParse(input);
  if (!result.success) return null;
  const data = result.data as BoardIndex;
  return { ...data, entries: dedupeEntries(data.entries) };
}

/** Parse an index from its raw JSON text; null on anything unusable. */
export function parseBoardIndexJson(raw: string): BoardIndex | null {
  try {
    return safeParseBoardIndex(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The one place a summary is built. Both writers — the save path and the
 * rebuild path — go through here, which is what makes the "derived, never
 * supplied" claim above true rather than a convention two authors have to
 * remember.
 */
export function summarize(id: string, board: Board): BoardSummary {
  return { id, title: board.meta.title, updatedAt: board.meta.updatedAt };
}

export function emptyBoardIndex(): BoardIndex {
  return { version: 1, currentId: null, entries: [] };
}

/** Newest first — the order the Open dialog lists boards in. */
export function byRecency(entries: BoardSummary[]): BoardSummary[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Collapse entries that name the same board to one — the freshest, by `updatedAt`.
 * The index is meant to hold at most one summary per id (the save path upserts), but
 * a library that survived an earlier re-seed can carry a duplicate on disk; left in,
 * it lists a board twice and collides its React key. Deduping at the read boundary
 * (see `safeParseBoardIndex`) heals every consumer, and the next save writes the
 * collapsed index back to disk.
 */
export function dedupeEntries(entries: BoardSummary[]): BoardSummary[] {
  const best = new Map<string, BoardSummary>();
  for (const e of entries) {
    const prev = best.get(e.id);
    if (!prev || e.updatedAt.localeCompare(prev.updatedAt) > 0) best.set(e.id, e);
  }
  return [...best.values()];
}
