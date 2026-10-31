import { createSignal } from 'solid-js';
import type { CanvasHandle, FitOptions } from '@wired-square/canvas/core';
import type { CardNodeData, StringEdgeData } from '../../types/canvas';
import { awaitFit, settleFit, type PendingFit } from '../../components/canvas/pendingFit';

export type Camera = CanvasHandle<CardNodeData, StringEdgeData> & {
  /** `fitView`, held until the store's change has drawn the ids it frames. */
  fitWhenDrawn(options: FitOptions): void;
};

// A module signal, not a context: the toolbar, drawer and dialogs mount as islands of their own.
export const [camera, setCamera] = createSignal<Camera | null>(null);

export function withFitWhenDrawn(base: CanvasHandle<CardNodeData, StringEdgeData>): Camera {
  const isDrawn = (id: string) => !!base.getNode(id);
  const setNodes = base.setNodes;
  let pending: PendingFit | null = null;
  // The binding calls setNodes from its own effect, so wrapping it is what settles
  // the fit after the canvas has the nodes, whichever effect runs first.
  return Object.assign(base, {
    setNodes(nodes: Parameters<typeof setNodes>[0]) {
      setNodes(nodes);
      if (!pending) return;
      const step = settleFit(pending, isDrawn, performance.now());
      if (step === 'wait') return;
      const { options } = pending;
      pending = null;
      if (step === 'fit') void base.fitView(options);
    },
    fitWhenDrawn(options: FitOptions) {
      pending = awaitFit(options, isDrawn, performance.now());
      if (!pending) void base.fitView(options);
    },
  });
}
