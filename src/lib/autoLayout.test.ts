import { describe, expect, it } from 'vitest';
import type { Connection } from '../types/board';
import { arrangedPositions, type LayoutNode } from './autoLayout';

const W = 210;
const H = 150;

function node(id: string, x: number, y: number, clusterId: string | null = null): LayoutNode {
  return { id, position: { x, y }, width: W, height: H, clusterId };
}

function link(source: string, target: string): Connection {
  return { id: `${source}-${target}`, source, target, kind: 'red-string' };
}

// Centre-to-centre distance between two cards from their tidied top-left positions.
function centreDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('arrangedPositions', () => {
  it('has nothing to tidy with fewer than two cards', () => {
    expect(arrangedPositions([], []).size).toBe(0);
    expect(arrangedPositions([node('a', 0, 0)], []).size).toBe(0); // one card → nothing to move
  });

  it('pulls two connected cards together (untangles/shortens the string)', () => {
    const before = 2000; // far apart on the x axis
    const pos = arrangedPositions([node('a', 0, 0), node('b', before, 0)], [link('a', 'b')]);
    const d = centreDist(pos.get('a')!, pos.get('b')!);
    // Much closer than they started, but collision keeps them off each other.
    expect(d).toBeLessThan(600);
    expect(d).toBeGreaterThan(W / 2); // not stacked
  });

  it('pushes two overlapping unconnected cards apart (no overlap)', () => {
    // Almost fully overlapping to begin with.
    const pos = arrangedPositions([node('a', 0, 0), node('b', 30, 0)], []);
    const d = centreDist(pos.get('a')!, pos.get('b')!);
    // Separated by at least a card's worth — they no longer sit on top of each other.
    expect(d).toBeGreaterThan(W);
  });

  it('gathers same-cluster cards nearer each other than a card from another cluster', () => {
    // Two clusters seeded interleaved, so only the cluster force can group them.
    const nodes = [
      node('a1', 0, 0, 'c1'),
      node('b1', 300, 0, 'c2'),
      node('a2', 600, 0, 'c1'),
      node('b2', 900, 0, 'c2'),
    ];
    const pos = arrangedPositions(nodes, []);
    const withinC1 = centreDist(pos.get('a1')!, pos.get('a2')!);
    const acrossClusters = centreDist(pos.get('a1')!, pos.get('b2')!);
    expect(withinC1).toBeLessThan(acrossClusters);
  });
});
