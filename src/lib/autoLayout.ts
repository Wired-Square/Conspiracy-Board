import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Connection, Vec2 } from '../types/board';

// The auto-adjust ("Tidy") layout. It answers three things the user asked for at
// once, which is exactly what a force simulation is for: untangle the string (a
// spring on every connection pulls joined cards together, so the string shortens
// and stops crossing itself), bring everything closer (a gentle pull to centre,
// and no long-range repulsion — only collision keeps cards off each other), and
// group by cluster a bit (a soft pull toward each cluster's own centroid).
//
// It refines rather than reshuffles: nodes start from where they already are, so
// the board the user knows is nudged into shape, not scattered and regrown.

// A card face is 210px wide (see .evidence-card). A card is treated as a disc big
// enough to contain it — half its diagonal — so two non-overlapping discs mean two
// non-overlapping cards, whatever their aspect. A little breathing room on top.
const COLLIDE_MARGIN = 12;
// Rest length of a connection's spring: about a card-and-a-half apart, close enough
// to read as joined without stacking.
const LINK_DISTANCE = 240;
// How hard same-cluster cards clump, and how hard the whole board pulls inward.
// Both deliberately weak — "a bit" — so connections and collision still lead.
const CLUSTER_PULL = 0.06;
const CENTRE_PULL = 0.02;
// Enough ticks for the simulation to settle at the default cooling schedule.
const TICKS = 300;

/** The board a card is drawn on: what Tidy needs to know to place it. */
export type LayoutNode = {
  id: string;
  position: Vec2;
  width: number;
  height: number;
  clusterId: string | null;
};

// d3 mutates its node objects in place, filling in x/y/vx/vy; ours also carry the
// radius and cluster so the forces can read them.
type SimNode = SimulationNodeDatum & {
  id: string;
  radius: number;
  clusterId: string | null;
};

function centroid(nodes: SimNode[]): { x: number; y: number } {
  const sum = nodes.reduce((a, n) => ({ x: a.x + n.x!, y: a.y + n.y! }), { x: 0, y: 0 });
  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

/**
 * New positions for the given board cards. Only cards passed in are moved; the
 * caller decides that set (the drawn, visible ones). Returns a map from card id to
 * its tidied top-left position, ready for `arrangeCards`.
 */
export function arrangedPositions(
  nodes: LayoutNode[],
  connections: Connection[],
): Map<string, Vec2> {
  const result = new Map<string, Vec2>();
  // Nothing to untangle with fewer than two cards.
  if (nodes.length < 2) return result;

  // Seed from current centres (d3 works in centres; cards store top-left corners).
  const sim: SimNode[] = nodes.map((n) => ({
    id: n.id,
    x: n.position.x + n.width / 2,
    y: n.position.y + n.height / 2,
    radius: Math.hypot(n.width, n.height) / 2 + COLLIDE_MARGIN,
    clusterId: n.clusterId,
  }));
  const byId = new Map(sim.map((n) => [n.id, n]));

  // Only strings between two cards we're arranging pull anything.
  const links: SimulationLinkDatum<SimNode>[] = connections
    .filter((c) => byId.has(c.source) && byId.has(c.target))
    .map((c) => ({ source: c.source, target: c.target }));

  // Each cluster's current centre, so its cards gather around where they already
  // are rather than all clusters piling onto one point.
  const clusterCentre = new Map<string, { x: number; y: number }>();
  for (const id of new Set(sim.map((n) => n.clusterId).filter((c): c is string => !!c))) {
    clusterCentre.set(id, centroid(sim.filter((n) => n.clusterId === id)));
  }
  const board = centroid(sim);
  const pullX = (n: SimNode) => (n.clusterId ? clusterCentre.get(n.clusterId)!.x : board.x);
  const pullY = (n: SimNode) => (n.clusterId ? clusterCentre.get(n.clusterId)!.y : board.y);

  const simulation = forceSimulation(sim)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((n) => n.id).distance(LINK_DISTANCE))
    // A whisper of repulsion so cards that share no string still ease apart before
    // collision has to shove them; collision does the real anti-overlap work.
    .force('charge', forceManyBody<SimNode>().strength(-30))
    .force('collide', forceCollide<SimNode>((n) => n.radius).strength(0.9).iterations(2))
    .force('clusterX', forceX<SimNode>(pullX).strength(CLUSTER_PULL))
    .force('clusterY', forceY<SimNode>(pullY).strength(CLUSTER_PULL))
    .force('centreX', forceX<SimNode>(board.x).strength(CENTRE_PULL))
    .force('centreY', forceY<SimNode>(board.y).strength(CENTRE_PULL))
    .stop();

  for (let i = 0; i < TICKS; i++) simulation.tick();

  // Back to top-left corners, rounded so positions stay tidy in the saved board.
  for (let i = 0; i < nodes.length; i++) {
    const n = sim[i];
    result.set(n.id, {
      x: Math.round(n.x! - nodes[i].width / 2),
      y: Math.round(n.y! - nodes[i].height / 2),
    });
  }
  return result;
}
