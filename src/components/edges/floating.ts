import { Position, type InternalNode, type Node } from '@xyflow/react';

// Floating-edge geometry: find where the line between two node centres crosses
// each node's border, and which side that is. Adapted from React Flow's
// "floating edges" example so connections attach to the nearest clean side
// (top/right/bottom/left) rather than fixed handles.

type RFNode = InternalNode<Node>;

const dims = (n: RFNode) => ({
  w: n.measured?.width ?? 0,
  h: n.measured?.height ?? 0,
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
});

/** Point on `node`'s border along the line toward `other`'s centre. */
function intersection(node: RFNode, other: RFNode) {
  const n = dims(node);
  const o = dims(other);
  const w = n.w / 2;
  const h = n.h / 2;
  const x2 = n.x + w;
  const y2 = n.y + h;
  const x1 = o.x + o.w / 2;
  const y1 = o.y + o.h / 2;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

/** Which side of `node` the border point sits on. */
function sideOf(node: RFNode, p: { x: number; y: number }): Position {
  const n = dims(node);
  if (Math.round(p.x) <= Math.round(n.x) + 1) return Position.Left;
  if (Math.round(p.x) >= Math.round(n.x + n.w) - 1) return Position.Right;
  if (Math.round(p.y) <= Math.round(n.y) + 1) return Position.Top;
  return Position.Bottom;
}

export function getEdgeParams(source: RFNode, target: RFNode) {
  const sp = intersection(source, target);
  const tp = intersection(target, source);
  return {
    sx: sp.x,
    sy: sp.y,
    tx: tp.x,
    ty: tp.y,
    sourcePos: sideOf(source, sp),
    targetPos: sideOf(target, tp),
  };
}
