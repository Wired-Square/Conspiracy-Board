import { describe, expect, it } from 'vitest';
import type { CardKind } from '../types/board';
import { highlight, highlightClass, linkDegrees, tieScaleInterner } from './highlight';

type TestNode = { id: string; className?: string; selected?: boolean; data: { card: { kind: CardKind } } };
type TestEdge = { id: string; source: string; target: string; className?: string };

const node = (id: string, kind: CardKind = 'evidence'): TestNode => ({ id, data: { card: { kind } } });
const edge = (id: string, source: string, target: string): TestEdge => ({ id, source, target });

describe('highlightClass', () => {
  it('lights the focus and its neighbours, and dims the rest', () => {
    expect(highlightClass(true, false, true, false)).toBe('hl');
    expect(highlightClass(true, false, false, false)).toBe('dim');
    expect(highlightClass(false, false, false, false)).toBeUndefined();
  });

  it('lets the search own the dim, under the focus', () => {
    expect(highlightClass(false, true, false, true)).toBeUndefined();
    expect(highlightClass(false, true, false, false)).toBe('dim');
    expect(highlightClass(true, true, true, false)).toBe('hl');
  });
});

describe('linkDegrees', () => {
  it('counts both ends', () => {
    expect([...linkDegrees([edge('1', 'a', 'b'), edge('2', 'a', 'c')])]).toEqual([
      ['a', 2],
      ['b', 1],
      ['c', 1],
    ]);
  });
});

describe('tieScaleInterner', () => {
  it('hands back the same object for the same data and scale', () => {
    const intern = tieScaleInterner<{ x: number; tieScale?: number }>();
    const data = { x: 1 };
    expect(intern(data, undefined)).toBe(data);
    expect(intern(data, 1.2)).toBe(intern(data, 1.2));
    expect(intern(data, 1.2)).toEqual({ x: 1, tieScale: 1.2 });
  });
});

describe('highlight', () => {
  const nodes = [node('a'), node('b'), node('c'), node('p', 'person')];
  const edges = [edge('ab', 'a', 'b')];
  const pass = (focusId: string | null, matchIds: Set<string> | null = null) =>
    highlight(nodes, edges, { focusId, selectedId: 'a', matchIds, degrees: linkDegrees(edges) }, tieScaleInterner());

  it('lights the focus and its strings, and dims the rest', () => {
    const { nodes: n, edges: e } = pass('a');
    expect(n.map((x) => x.className)).toEqual(['hl', 'hl', 'dim', 'dim']);
    expect(n[0].selected).toBe(true);
    expect(e[0].className).toBe('hl');
  });

  it('scales only the actors', () => {
    const { nodes: n } = pass(null);
    expect(n[3].data).toHaveProperty('tieScale', 1);
    expect(n[2].data).not.toHaveProperty('tieScale');
  });

  it('keeps an unchanged element as the same object', () => {
    const plain = [node('x')];
    const out = highlight(plain, [], { focusId: null, selectedId: null, matchIds: null, degrees: new Map() }, tieScaleInterner());
    expect(out.nodes[0]).toBe(plain[0]);
  });

  it('dims what the search does not match', () => {
    const { edges: e, nodes: n } = pass(null, new Set(['a']));
    expect(n.map((x) => x.className)).toEqual([undefined, 'dim', 'dim', 'dim']);
    expect(e[0].className).toBe('dim');
  });
});
