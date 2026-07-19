import { describe, it, expect } from 'vitest';
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  buildManifest,
  parseManifest,
} from './bundle';
import type { Board } from '../types/board';

function board(title: string): Board {
  return {
    version: 3,
    meta: { title, updatedAt: '2026-07-19T00:00:00.000Z' },
    clusters: [],
    cards: [],
    connections: [],
  };
}

describe('bundle manifest', () => {
  it('names the format and version, and points at each board file', () => {
    const m = buildManifest([
      { id: 'brd_aaa', board: board('First') },
      { id: 'brd_bbb', board: board('Second') },
    ]);
    expect(m.format).toBe(BUNDLE_FORMAT);
    expect(m.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(m.boards).toEqual([
      { id: 'brd_aaa', title: 'First', file: 'boards/brd_aaa.json' },
      { id: 'brd_bbb', title: 'Second', file: 'boards/brd_bbb.json' },
    ]);
  });

  it('round-trips through parse', () => {
    const m = buildManifest([{ id: 'brd_aaa', board: board('Only') }]);
    const parsed = parseManifest(JSON.stringify(m));
    expect(parsed).toEqual(m);
  });

  it('rejects non-JSON, the wrong shape, and a foreign format', () => {
    expect(parseManifest('not json')).toBeNull();
    expect(parseManifest('{}')).toBeNull(); // missing format/version
    expect(parseManifest(JSON.stringify({ format: 'something-else', formatVersion: 1 }))).toBeNull();
  });
});
