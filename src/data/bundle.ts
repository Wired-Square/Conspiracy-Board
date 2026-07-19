import { z } from 'zod';
import type { Board } from '../types/board';

// The manifest that names a bundle a bundle. A `.zip` of boards + media is
// otherwise just some zip; `format`/`formatVersion` are the signature that lets
// import recognise one (and refuse or upgrade a future layout), and `boards` is
// the enumeration — order and an advisory title — so the import dialog can be
// populated. The title is advisory only: the real pre-fill comes from each board's
// freshly-parsed `meta.title`, since a hand-edited manifest could disagree.
//
// This module is pure (no IO) so the format lives in one place and can be tested
// directly. The shell (src-tauri/src/board_store.rs) treats the manifest as opaque
// bytes — it authors nothing and validates nothing here.

export const BUNDLE_FORMAT = 'conspiracy-bundle';
export const BUNDLE_FORMAT_VERSION = 1;

export type BundleManifestBoard = { id: string; title: string; file: string };

export type BundleManifest = {
  format: string;
  formatVersion: number;
  app: string;
  exportedAt: string;
  boards: BundleManifestBoard[];
};

/** The manifest for a set of boards about to be bundled. */
export function buildManifest(boards: { id: string; board: Board }[]): BundleManifest {
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    app: 'Conspiracy',
    exportedAt: new Date().toISOString(),
    boards: boards.map(({ id, board }) => ({
      id,
      title: board.meta.title,
      file: `boards/${id}.json`,
    })),
  };
}

const manifestSchema = z.object({
  format: z.string(),
  formatVersion: z.number(),
  app: z.string().default('Conspiracy'),
  exportedAt: z.string().default(''),
  boards: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().default(''),
        file: z.string().default(''),
      }),
    )
    .default([]),
});

/**
 * Parse a bundle manifest; null on unparseable JSON, an invalid shape, or a format
 * that isn't ours. A null is not fatal to an import — the manifest is advisory, so
 * a bundle without a readable one falls back to zip order and each board's own
 * title (which tolerates a hand-made zip).
 */
export function parseManifest(raw: string): BundleManifest | null {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.format !== BUNDLE_FORMAT) return null;
    return parsed.data as BundleManifest;
  } catch {
    return null;
  }
}

/**
 * Order items carrying a bundle id by the manifest, so an import lists boards as
 * they were exported. Items the manifest doesn't name (a hand-made zip) keep their
 * order at the end; with no manifest the order is left untouched.
 */
export function orderByManifest<T extends { id: string }>(
  items: T[],
  manifest: BundleManifest | null,
): T[] {
  if (!manifest) return items;
  const order = new Map(manifest.boards.map((b, i) => [b.id, i]));
  return [...items].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}
