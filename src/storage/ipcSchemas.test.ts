import { describe, expect, it } from 'vitest';
import {
  docHitSchema,
  docStatusSchema,
  fetchedImageSchema,
  loadedBoardSchema,
  mediaEntrySchema,
  mediaMetaSchema,
  readBundleSchema,
} from './ipcSchemas';

describe('IPC return-payload schemas', () => {
  it('accepts the shapes the shell actually sends', () => {
    expect(loadedBoardSchema.parse({ json: '{}', legacy: false })).toEqual({
      json: '{}',
      legacy: false,
    });
    expect(loadedBoardSchema.parse({ json: null, legacy: true }).json).toBeNull();
    expect(fetchedImageSchema.parse({ b64: 'aGk=', mime: null }).mime).toBeNull();
    expect(mediaEntrySchema.parse({ name: 'ab.png', size: 12 }).size).toBe(12);
    expect(docStatusSchema.parse({ name: 'ab.pdf', status: 'indexed' }).status).toBe('indexed');
    expect(docHitSchema.parse({ name: 'ab.pdf', snippet: '…x…', rank: -1.2 }).rank).toBe(-1.2);
    expect(
      readBundleSchema.parse({ manifest: null, boards: [{ id: 'b1', json: '{}' }] }).boards,
    ).toHaveLength(1);
  });

  it('strips the nulls Rust sends for absent metadata, keeping what is real', () => {
    // A screenshot: dimensions but no EXIF — every absent Option arrives null.
    const parsed = mediaMetaSchema.parse({
      title: null,
      author: null,
      created: null,
      modified: null,
      pages: null,
      words: null,
      width: 1288,
      height: 672,
      takenAt: null,
      cameraMake: null,
      cameraModel: null,
      latitude: null,
      longitude: null,
    });
    expect(parsed).toEqual({ width: 1288, height: 672 });
  });

  it('accepts a wholly empty metadata answer', () => {
    expect(mediaMetaSchema.parse({})).toEqual({});
  });

  it('rejects a drifted shape loudly rather than passing it through', () => {
    // A renamed field on the Rust side must fail here, at the boundary.
    expect(loadedBoardSchema.safeParse({ body: '{}', legacy: false }).success).toBe(false);
    expect(docHitSchema.safeParse({ name: 'x', snippet: 'y', score: 1 }).success).toBe(false);
    expect(mediaEntrySchema.safeParse({ name: 'x', size: '12' }).success).toBe(false);
  });
});
