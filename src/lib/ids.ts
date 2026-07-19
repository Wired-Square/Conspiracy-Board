export const newCardId = (): string => `card_${crypto.randomUUID().slice(0, 8)}`;
export const newEdgeId = (): string => `edge_${crypto.randomUUID().slice(0, 8)}`;
export const newClusterId = (): string => `cl_${crypto.randomUUID().slice(0, 8)}`;
export const newBoardId = (): string => `brd_${crypto.randomUUID().slice(0, 8)}`;
