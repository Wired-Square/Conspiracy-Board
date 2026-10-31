import { describe, it, expect } from 'vitest';
import { buildManifest } from './bundle';
import type { Board } from '../types/board';

function board(title: string): Board {
  return {
    version: 4,
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
    expect(m.format).toBe('conspiracy-bundle');
    expect(m.formatVersion).toBe(1);
    expect(m.boards).toEqual([
      { id: 'brd_aaa', title: 'First', file: 'boards/brd_aaa.json' },
      { id: 'brd_bbb', title: 'Second', file: 'boards/brd_bbb.json' },
    ]);
  });
});
