import { describe, expect, it } from 'vitest';
import type { ImageCrop } from '../types/board';
import { clampOffset, coverScale, cropToView, viewToCrop, type Geom } from './imageCrop';

// A 4:3 frame and a 4:3 image, the case the cropper is built around.
const GEOM: Geom = { fw: 400, fh: 300, natW: 800, natH: 600 };

const roughly = (a: number, b: number) => expect(a).toBeCloseTo(b, 8);

describe('coverScale', () => {
  it('is the larger of the two axis ratios, so the image covers the frame', () => {
    // Wider-than-frame image is bound by height; taller by width.
    roughly(coverScale(GEOM), 0.5); // same aspect: either axis, 400/800
    roughly(coverScale({ fw: 400, fh: 300, natW: 1000, natH: 500 }), 0.6); // wide image: 300/500 wins
    roughly(coverScale({ fw: 400, fh: 300, natW: 500, natH: 1000 }), 0.8); // tall image: 400/500 wins
  });
});

describe('cropToView ⇄ viewToCrop', () => {
  it('round-trips a crop through a view and back', () => {
    // Every crop is 4:3 (authored in the 4:3 frame): w·NW : h·NH = 4 : 3. The view
    // fixes scale from the width, so the height must agree or it is not recoverable.
    for (const crop of [
      { x: 0, y: 0, w: 1, h: 1 }, // the whole image
      { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, // a centred zoom
      { x: 0.1, y: 0.2, w: 0.6, h: 0.6 }, // an off-centre region (480×360 px = 4:3)
    ] satisfies ImageCrop[]) {
      const { scale, tx, ty } = cropToView(crop, GEOM);
      const back = viewToCrop(scale, tx, ty, GEOM);
      roughly(back.x, crop.x);
      roughly(back.y, crop.y);
      roughly(back.w, crop.w);
      roughly(back.h, crop.h);
    }
  });

  it('cover-fit at the minimum scale is the whole image', () => {
    const crop = viewToCrop(coverScale(GEOM), 0, 0, GEOM);
    expect(crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('clampOffset', () => {
  it('never lets the image uncover the frame', () => {
    const scale = coverScale(GEOM); // image is exactly frame-sized here
    // Any drift off zero is pulled back, since the image only just covers.
    expect(clampOffset(scale, 50, -20, GEOM)).toEqual({ tx: 0, ty: 0 });
  });

  it('allows panning while the image is larger than the frame', () => {
    const scale = coverScale(GEOM) * 2; // zoomed in: room to move
    const { tx, ty } = clampOffset(scale, -100, -100, GEOM);
    roughly(tx, -100);
    roughly(ty, -100);
    // But not so far that an edge comes into view.
    expect(clampOffset(scale, 10, 10, GEOM)).toEqual({ tx: 0, ty: 0 });
  });
});
