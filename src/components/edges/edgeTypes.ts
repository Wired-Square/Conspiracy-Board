import type { EdgeTypes } from '@xyflow/react';
import { RedStringEdge } from './RedStringEdge';

// Module scope: avoids React Flow re-instantiating edge types each render.
export const edgeTypes: EdgeTypes = {
  redString: RedStringEdge,
};
