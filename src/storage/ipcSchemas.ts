import { z } from 'zod';
import { documentPropsSchema, imageMetaSchema, withoutNulls } from '../data/schema';
import type { DocHit, DocStatus, MediaEntry, MediaMeta } from './StorageAdapter';

// Return-payload schemas for the shell's commands, one per value-returning
// invoke in tauriStorage. The Rust structs and the adapter's TS types are
// mirrored by hand; each schema here is typed against the adapter's type
// (z.ZodType<T>), so the schema and the type cannot drift from each other —
// only from Rust, which is exactly what parsing on receipt catches.
//
// In their own module (no tauri import) so tests can exercise them under node.

export const loadedBoardSchema: z.ZodType<{ json: string | null; legacy: boolean }> = z.object({
  json: z.string().nullable(),
  legacy: z.boolean(),
});

export const fetchedImageSchema: z.ZodType<{ b64: string; mime: string | null }> = z.object({
  b64: z.string(),
  mime: z.string().nullable(),
});

/**
 * extract_media_meta: Rust's `Option::None` arrives as `null`; strip to absent.
 * Composed from the schema layer's own shapes — MediaMeta is by construction
 * the document properties plus the image fields, so a field added there is
 * accepted here without a second hand-written list to remember.
 */
export const mediaMetaSchema: z.ZodType<MediaMeta> = z.preprocess(
  withoutNulls,
  z.object({ ...documentPropsSchema.shape, ...imageMetaSchema.shape }),
);

export const mediaEntrySchema: z.ZodType<MediaEntry> = z.object({
  name: z.string(),
  size: z.number(),
});

export const docStatusSchema: z.ZodType<DocStatus> = z.object({
  name: z.string(),
  status: z.string(),
});

export const docHitSchema: z.ZodType<DocHit> = z.object({
  name: z.string(),
  snippet: z.string(),
  rank: z.number(),
});

export const readBundleSchema: z.ZodType<{
  manifest: string | null;
  boards: { id: string; json: string }[];
}> = z.object({
  manifest: z.string().nullable(),
  boards: z.array(z.object({ id: z.string(), json: z.string() })),
});
