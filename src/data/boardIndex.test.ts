import { describe, expect, it } from 'vitest';
import { byRecency, emptyBoardIndex, parseBoardIndexJson } from './boardIndex';

const parse = (input: unknown) => parseBoardIndexJson(JSON.stringify(input));

const index = {
  version: 1,
  currentId: 'brd_a',
  entries: [
    { id: 'brd_a', title: 'A', updatedAt: '2025-01-02T00:00:00.000Z' },
    { id: 'brd_b', title: 'B', updatedAt: '2025-01-01T00:00:00.000Z' },
  ],
};

describe('parseBoardIndexJson', () => {
  it('round-trips a valid index', () => {
    expect(parse(index)).toEqual(index);
  });

  it('defaults a bare index', () => {
    expect(parse({ version: 1 })).toEqual(emptyBoardIndex());
  });

  it('rejects garbage, which is what triggers a rebuild', () => {
    expect(parse(null)).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse({ version: 2, entries: [] })).toBeNull();
    expect(parse({ version: 1, entries: [{ id: 'x' }] })).toBeNull();
  });
});

describe('parseBoardIndexJson dedupe', () => {
  it('collapses a repeated id to the freshest summary', () => {
    const entries = [
      { id: 'brd_a', title: 'A (old)', updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'brd_b', title: 'B', updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'brd_a', title: 'A (new)', updatedAt: '2025-01-03T00:00:00.000Z' },
    ];
    const out = parse({ version: 1, entries })!.entries;
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.id === 'brd_a')?.title).toBe('A (new)');
    expect(out.map((e) => e.id)).toEqual(['brd_a', 'brd_b']);
  });

  it('leaves a unique index untouched', () => {
    expect(parse(index)!.entries).toEqual(index.entries);
  });

  it('drops a duplicate entry a legacy library carried on disk', () => {
    const parsed = parse({
      ...index,
      entries: [...index.entries, { id: 'brd_a', title: 'A dup', updatedAt: '2020-01-01T00:00:00.000Z' }],
    });
    expect(parsed?.entries).toHaveLength(2);
    expect(parsed?.entries.find((e) => e.id === 'brd_a')?.title).toBe('A');
  });
});

describe('byRecency', () => {
  it('sorts newest first', () => {
    expect(byRecency(index.entries).map((e) => e.id)).toEqual(['brd_a', 'brd_b']);
    expect(byRecency([...index.entries].reverse()).map((e) => e.id)).toEqual(['brd_a', 'brd_b']);
  });

  it('does not mutate its input', () => {
    const entries = [...index.entries].reverse();
    byRecency(entries);
    expect(entries.map((e) => e.id)).toEqual(['brd_b', 'brd_a']);
  });
});
