import { describe, expect, it } from 'vitest';
import type { Card, Cluster, Connection } from '../../types/board';
import { cardToNode, connectionToEdge, reconcileEdges, reconcileNodes } from './flowAdapter';

const clusters: Cluster[] = [
  { id: 'k1', label: 'One', color: '#e23b3b', visible: true },
  { id: 'k2', label: 'Two', color: '#3b7de2', visible: true },
];

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  notes: '',
  imageUrl: null,
  imageFile: null,
  imageCrop: null,
  imageMeta: null,
  clusterIds: ['k1'],
  kind: 'evidence',
  occurredAt: null,
  occurredAtPrecision: 'minute',
  position: { x: 0, y: 0 },
  ...over,
});

describe('reconcileNodes', () => {
  const a = card('a');
  const b = card('b');
  const prev = [cardToNode(a, clusters), cardToNode(b, clusters)];

  it('hands back the same array when nothing changed', () => {
    expect(reconcileNodes(prev, clusters, [a, b], clusters)).toBe(prev);
  });

  it('rebuilds only an edited card, and appends a new one', () => {
    const edited = { ...a, title: 'renamed' };
    const c = card('c');
    const next = reconcileNodes(prev, clusters, [edited, b, c], clusters);
    expect(next[0].data.card).toBe(edited);
    expect(next[1]).toBe(prev[1]);
    expect(next.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a settled drag’s node as it is', () => {
    const dragged = { ...prev[0], position: { x: 40, y: 50 }, measured: { width: 200, height: 150 } };
    const settled = { ...a, position: dragged.position };
    const next = reconcileNodes([dragged, prev[1]], clusters, [settled, b], clusters);
    expect(next[0]).toBe(dragged);
  });

  it('moves a tidied node, keeping its measured size', () => {
    const measured = { ...prev[0], measured: { width: 200, height: 150 } };
    const tidied = { ...a, position: { x: 300, y: 0 } };
    const [node] = reconcileNodes([measured, prev[1]], clusters, [tidied, b], clusters);
    expect(node.position).toEqual({ x: 300, y: 0 });
    expect(node.measured).toEqual({ width: 200, height: 150 });
    expect(node.data.card).toBe(tidied);
  });

  it('recolours only the cards a cluster change reaches', () => {
    const inTwo = card('b', { clusterIds: ['k2'] });
    const before = [prev[0], cardToNode(inTwo, clusters)];
    const recoloured = clusters.map((c) => (c.id === 'k2' ? { ...c, color: '#000000' } : c));
    const next = reconcileNodes(before, clusters, [a, inTwo], recoloured);
    expect(next[0]).toBe(before[0]);
    expect(next[1].data.clusterColor).toBe('#000000');
  });

  it('drops a deleted card', () => {
    expect(reconcileNodes(prev, clusters, [b], clusters)).toEqual([prev[1]]);
  });
});

describe('reconcileEdges', () => {
  const c1: Connection = { id: 'e1', source: 'a', target: 'b', kind: 'red-string' };
  const c2: Connection = { id: 'e2', source: 'b', target: 'c', kind: 'red-string' };
  const prev = [connectionToEdge(c1), connectionToEdge(c2)];

  it('keeps an edge whose connection is unchanged, even once selected', () => {
    const selected = [{ ...prev[0], selected: true }, prev[1]];
    expect(reconcileEdges(selected, [c1, c2])).toBe(selected);
  });

  it('rebuilds an updated connection’s edge', () => {
    const graded = { ...c2, grade: 'confirmed' as const };
    const next = reconcileEdges(prev, [c1, graded]);
    expect(next[0]).toBe(prev[0]);
    expect(next[1].data?.grade).toBe('confirmed');
  });
});
