import type { ImageCrop } from '../types/board';

// The maths behind the image cropper, kept pure and away from the component so it
// can be reasoned about and tested on its own. The cropper shows an image inside a
// fixed 4:3 frame; a "view" is what it is currently showing — the image's on-screen
// size (`scale`, on-screen px per natural px) and where its top-left sits relative
// to the frame's, in frame px (`tx`, `ty`, both ≤ 0 while the image covers the
// frame). A stored `ImageCrop` is the same region as fractions of the natural
// image, so it is display-size independent.

/** The frame and the image it holds: the frame's on-screen size and the image's
 *  natural pixels. Every function here needs some of these four, so they travel as
 *  one bundle rather than four positional args threaded through each call. */
export type Geom = { fw: number; fh: number; natW: number; natH: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The smallest scale at which the image still covers the whole frame — the floor
 *  the cropper never zooms below, so no bare frame ever shows. */
export function coverScale({ fw, fh, natW, natH }: Geom): number {
  return Math.max(fw / natW, fh / natH);
}

/** Keep the image covering the frame: its top-left may not come inside the frame,
 *  nor its bottom-right cross the opposite edge. */
export function clampOffset(scale: number, tx: number, ty: number, { fw, fh, natW, natH }: Geom): { tx: number; ty: number } {
  return {
    tx: clamp(tx, fw - natW * scale, 0),
    ty: clamp(ty, fh - natH * scale, 0),
  };
}

/** The view that frames a stored crop. The crop is 4:3 like the frame, so its
 *  width alone fixes the scale; the offset follows from its top-left corner. */
export function cropToView(crop: ImageCrop, { fw, natW, natH }: Geom): { scale: number; tx: number; ty: number } {
  const scale = fw / (crop.w * natW);
  return { scale, tx: -crop.x * natW * scale, ty: -crop.y * natH * scale };
}

/** The crop a view is currently showing, as fractions of the natural image and
 *  clamped into [0, 1] so a stored crop is always a valid region. */
export function viewToCrop(scale: number, tx: number, ty: number, { fw, fh, natW, natH }: Geom): ImageCrop {
  return {
    x: clamp(-tx / scale / natW, 0, 1),
    y: clamp(-ty / scale / natH, 0, 1),
    w: clamp(fw / scale / natW, 0, 1),
    h: clamp(fh / scale / natH, 0, 1),
  };
}
