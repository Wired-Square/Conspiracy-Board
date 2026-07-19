import { EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react';
import type { StringEdge } from '../../types/reactflow';
import { gradeTint } from '../../lib/grades';
import { getEdgeParams } from './floating';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Build a path that droops *downward* under gravity (like hanging yarn), plus
 * the point on that curve where a label tag should sit.
 */
function yarnPath(sx: number, sy: number, tx: number, ty: number) {
  const dist = Math.hypot(tx - sx, ty - sy);
  const sag = clamp(dist * 0.12, 16, 90);
  const c1x = sx + (tx - sx) / 3;
  const c2x = sx + ((tx - sx) * 2) / 3;
  const c1y = sy + (ty - sy) / 3 + sag;
  const c2y = sy + ((ty - sy) * 2) / 3 + sag;
  const path = `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
  // Label sits on the curve's sagged midpoint so it stays on the string.
  return { path, labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 + sag * 0.75 };
}

export function RedStringEdge({ source, target, data }: EdgeProps<StringEdge>) {
  // Floating: derive endpoints from the nodes' current positions so the string
  // ties to whichever side is closest, regardless of which handle was used.
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);
  const { path, labelX, labelY } = yarnPath(sx, sy, tx, ty);

  // Both strands are dyed the same way. A graded link wears its grade, and the
  // ungraded fall back to plain string — which is what var(--grade,
  // var(--string)) says in CSS. A derived link is always the Inference violet,
  // because that is precisely the claim it is making.
  const participant = data?.variant === 'participant';
  const grade = participant ? 'inference' : data?.grade;

  return (
    <>
      <g style={grade ? gradeTint(grade) : undefined}>
        {/* A derived link hangs under the same gravity but is drawn as one thin,
            faint strand: no shadow, no sheen, no knots. Nobody pinned it —
            the app inferred it from an address, and it must not read as
            something a hand tied to the board. */}
        {participant ? (
          <path className="derived-string__strand" d={path} />
        ) : (
          <>
            {/* shadow, main strand, sheen — layered for a round-yarn look */}
            <path className="red-string__shadow" d={path} />
            <path className="red-string__strand" d={path} />
            <path className="red-string__sheen" d={path} />
            {/* pin knots where the yarn meets each card */}
            <circle className="red-string__knot" cx={sx} cy={sy} r={4} />
            <circle className="red-string__knot" cx={tx} cy={ty} r={4} />
          </>
        )}
      </g>
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="red-string__tag"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) rotate(-2deg)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
