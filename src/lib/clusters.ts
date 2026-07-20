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

/** The primary cluster — the first membership — or null when there is none. */
export function primaryClusterId(clusterIds: readonly string[]): string | null {
  return clusterIds[0] ?? null;
}

// Membership surgery lives here with the ordering invariant it preserves —
// no duplicates, primary first — rather than in each caller's carefulness.

/** Membership added (appended, so an existing primary keeps its place). */
export function withMembership(clusterIds: readonly string[], id: string): string[] {
  return clusterIds.includes(id) ? [...clusterIds] : [...clusterIds, id];
}

/** Membership removed. Removing the primary promotes the next membership. */
export function withoutMembership(clusterIds: readonly string[], id: string): string[] {
  return clusterIds.filter((x) => x !== id);
}

/** The given cluster made primary — moved (or added) to the head. */
export function asPrimary(clusterIds: readonly string[], id: string): string[] {
  return [id, ...clusterIds.filter((x) => x !== id)];
}

const NO_EXTRAS: string[] = [];

/** Colours of the non-primary clusters, for the card face's dots. */
export function extraClusterColors(
  clusterIds: readonly string[],
  clusters: Cluster[],
): string[] {
  // The overwhelming case — zero or one membership — allocates nothing: this
  // runs for every card on every refreshNodes.
  if (clusterIds.length <= 1) return NO_EXTRAS;
  const colors: string[] = [];
  for (const id of clusterIds.slice(1)) {
    const c = clusterColor(id, clusters);
    if (c !== null) colors.push(c);
  }
  return colors;
}

export function hiddenClusterIds(clusters: Cluster[]): Set<string> {
  return new Set(clusters.filter((c) => !c.visible).map((c) => c.id));
}

/** A card/node is visible when it has no clusters, or at least one visible one. */
export function isVisible(clusterIds: readonly string[], hidden: Set<string>): boolean {
  return clusterIds.length === 0 || clusterIds.some((id) => !hidden.has(id));
}
