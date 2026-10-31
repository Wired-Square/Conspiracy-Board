import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Board, Card, Cluster, Connection, Viewport } from '../types/board';
import type { CardMove } from '../bindings/CardMove';
import type { DocChanged } from '../bindings/DocChanged';
import type { MetaPatch } from '../bindings/MetaPatch';

export type { DocChanged };

export type CardPatch = Partial<Omit<Card, 'id'>>;
export type ConnectionPatch = Partial<Omit<Connection, 'id'>>;
export type ClusterPatch = Partial<Omit<Cluster, 'id'>>;

// JSON drops an undefined field, which would leave the stored value in place; null
// clears it.
const clearing = <T extends object>(patch: T) =>
  Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null]));

// One at a time: the shell runs commands on a pool, so two in flight at once could
// commit in either order.
let last: Promise<unknown> = Promise.resolve();
function inOrder<T = void>(command: string, args: Record<string, unknown>): Promise<T> {
  const next = last.then(() => invoke<T>(command, args));
  last = next.catch(() => {});
  return next;
}

/** The open board's document, held and written by the shell (src-tauri/src/board_store/session.rs). */
export const doc = {
  open: (boardId: string) => inOrder<Board>('open_board_session', { boardId }),
  updateCard: (boardId: string, id: string, patch: CardPatch) =>
    inOrder('update_card', { boardId, id, patch: clearing(patch) }),
  /** An edit the user didn't make (a migration, a re-read of a file), kept off the undo log. */
  refreshCard: (boardId: string, id: string, patch: CardPatch) =>
    inOrder('refresh_card', { boardId, id, patch: clearing(patch) }),
  moveCards: (boardId: string, moves: CardMove[]) => inOrder('move_cards', { boardId, moves }),
  addCards: (boardId: string, cards: Card[], connections: Connection[] = []) =>
    inOrder('add_cards', { boardId, cards, connections }),
  deleteCards: (boardId: string, ids: string[]) => inOrder('delete_cards', { boardId, ids }),
  addConnections: (boardId: string, connections: Connection[]) =>
    inOrder('add_connections', { boardId, connections }),
  updateConnection: (boardId: string, id: string, patch: ConnectionPatch) =>
    inOrder('update_connection', { boardId, id, patch: clearing(patch) }),
  deleteConnections: (boardId: string, ids: string[]) => inOrder('delete_connections', { boardId, ids }),
  addCluster: (boardId: string, cluster: Cluster) => inOrder('add_cluster', { boardId, cluster }),
  updateCluster: (boardId: string, id: string, patch: ClusterPatch) =>
    inOrder('update_cluster', { boardId, id, patch: clearing(patch) }),
  deleteCluster: (boardId: string, id: string) => inOrder('delete_cluster', { boardId, id }),
  setMeta: (boardId: string, patch: MetaPatch) => inOrder('set_meta', { boardId, patch }),
  setViewport: (boardId: string, viewport: Viewport) => inOrder('set_viewport', { boardId, viewport }),
  undo: (boardId: string) => inOrder('undo', { boardId }),
  redo: (boardId: string) => inOrder('redo', { boardId }),
  /** Every edit to the open board, whoever made it. */
  listen: (handler: (change: DocChanged) => void) => listen<DocChanged>('doc:changed', (e) => handler(e.payload)),
};
