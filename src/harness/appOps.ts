import type { AppOps } from '@wired-square/mcp-bridge/tauri-bridge';
import { boardStore } from '../store/boardStore';

export const appOps: AppOps = {
  board_summary: () => {
    const { currentBoardId, meta, cards, connections, clusters } = boardStore.getState();
    return {
      id: currentBoardId,
      title: meta.title,
      cards: cards.length,
      connections: connections.length,
      clusters: clusters.length,
    };
  },
};
