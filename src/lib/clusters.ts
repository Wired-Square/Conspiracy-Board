import type { Cluster } from '../types/board';

// Cluster facts consumed in several shapes — React Flow nodes on the board,
// canonical cards on the timeline, rows in the record — so the rules live here
// rather than being re-derived by each consumer.

/**
 * The accent a card with no cluster wears. One grey, so a card that belongs to
 * no strand looks the same everywhere it is drawn — the alternative was this
 * literal falling out of four `?? '#888'` and drifting when one was tuned. Also
 * `--accent`'s default in the stylesheet.
 */
export const NO_CLUSTER_ACCENT = '#888';

/** The accent colour for a cluster, or null when a card has no cluster. */
export function clusterColor(
  clusterId: string | null,
  clusters: Cluster[],
): string | null {
  return clusters.find((c) => c.id === clusterId)?.color ?? null;
}

export function hiddenClusterIds(clusters: Cluster[]): Set<string> {
  return new Set(clusters.filter((c) => !c.visible).map((c) => c.id));
}

/** A card/node is visible unless its cluster is explicitly hidden. */
export function isVisible(clusterId: string | null, hidden: Set<string>): boolean {
  return !clusterId || !hidden.has(clusterId);
}
