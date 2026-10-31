const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Build a path that droops *downward* under gravity (like hanging yarn), plus
 * the point on that curve where a label tag should sit.
 */
export function yarnPath(sx: number, sy: number, tx: number, ty: number) {
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
