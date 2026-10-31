import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { createCanvas, type CanvasHandle, type CanvasOptions, type PanelPosition } from '@wired-square/canvas/core';
import type { CardNode, CardNodeData, StringEdge, StringEdgeData } from '../../types/canvas';

export type Camera = CanvasHandle<CardNodeData, StringEdgeData>;

const CameraContext = createContext<[Camera | null, Dispatch<SetStateAction<Camera | null>>] | null>(null);

/** Shares the board canvas's camera with the panels, drawers and dialogs beside it. */
export function CameraProvider({ children }: { children: ReactNode }) {
  return <CameraContext.Provider value={useState<Camera | null>(null)}>{children}</CameraContext.Provider>;
}

/** The camera of the board canvas, once it has mounted. */
export function useCamera(): Camera | null {
  const scope = useContext(CameraContext);
  if (!scope) throw new Error('useCamera needs a CameraProvider around it');
  return scope[0];
}

export function CanvasPanel({ position, children }: { position: PanelPosition; children: ReactNode }) {
  return (
    <div className="app-canvas-panel nopan nowheel" data-position={position}>
      {children}
    </div>
  );
}

type CanvasProps = Omit<CanvasOptions<CardNodeData, StringEdgeData>, 'mount'> & {
  nodes: CardNode[];
  edges: StringEdge[];
  renderNode(node: CardNode): ReactNode;
};

/**
 * The board canvas over `createCanvas`. Its options are read once, at mount, and
 * its callbacks whenever they fire; remount it to start a new camera. Each node
 * mounted is a portal of `renderNode` into the element the canvas gives it.
 */
export function Canvas({ nodes, edges, renderNode, ...options }: CanvasProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  const setCamera = useContext(CameraContext)?.[1];
  const [canvas, setCanvas] = useState<Camera | null>(null);
  const [mounted, setMounted] = useState<ReadonlyMap<string, HTMLElement>>(new Map());

  useLayoutEffect(() => {
    latest.current = options;
  });

  useLayoutEffect(() => {
    const on = latest.current;
    const handle: Camera = createCanvas(root.current!, {
      ...on,
      mount(element, node) {
        setMounted((m) => new Map(m).set(node.id, element));
        return () =>
          setMounted((m) => {
            if (m.get(node.id) !== element) return m;
            const next = new Map(m);
            next.delete(node.id);
            return next;
          });
      },
      onNodeClick: (node, event) => latest.current.onNodeClick?.(node, event),
      onNodeEnter: (node) => latest.current.onNodeEnter?.(node),
      onNodeLeave: (node) => latest.current.onNodeLeave?.(node),
      onPaneClick: (event) => latest.current.onPaneClick?.(event),
      onNodeDragEnd: (node, position) => latest.current.onNodeDragEnd?.(node, position),
      onConnect: (source, target) => latest.current.onConnect?.(source, target),
      onMoveEnd: (viewport) => latest.current.onMoveEnd?.(viewport),
    });
    setCanvas(handle);
    setCamera?.(handle);
    return () => {
      handle.destroy();
      setCamera?.((current) => (current === handle ? null : current));
    };
  }, [setCamera]);

  useLayoutEffect(() => canvas?.setNodes(nodes), [canvas, nodes]);
  useLayoutEffect(() => canvas?.setEdges(edges), [canvas, edges]);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (
    <div ref={root} className="board-canvas">
      {[...mounted].map(([id, element]) => {
        const node = byId.get(id);
        return node && createPortal(renderNode(node), element, id);
      })}
    </div>
  );
}
