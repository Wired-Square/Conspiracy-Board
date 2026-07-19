import type { NodeTypes } from '@xyflow/react';
import { EvidenceCardNode } from './EvidenceCardNode';

// Defined at module scope so React Flow doesn't re-instantiate node types on
// every render.
export const nodeTypes: NodeTypes = {
  evidenceCard: EvidenceCardNode,
};
