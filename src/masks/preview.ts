/** A small greyscale picture of a mask (white = adjusted), for the Masks list. Uses the same mask maths as rendering. */
import { flattenMasks, maskValue } from './evaluate';
import type { Span } from './types';
import type { Mask } from './types';
import type { Vec3 } from '../color/colorSpace';

/** `sample(mx, my)` returns the picture's LINEAR colour at a mask-space position (range masks look at it). Returns w×h 0..255 values, row 0 = top. */
export function maskPreview(mask: Mask, span: Span, sample: (mx: number, my: number) => Vec3, w = 48, h = 36): Uint8ClampedArray {
  const t = flattenMasks([{ ...mask, enabled: true }]);
  const out = new Uint8ClampedArray(w * h);
  if (t.count === 0) return out;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const mx = ((x + 0.5) / w - 0.5) * 2 * span.hw, my = ((y + 0.5) / h - 0.5) * 2 * span.hh;
    out[y * w + x] = Math.round(Math.min(1, Math.max(0, maskValue(t, 0, mx, my, sample(mx, my)))) * 255);
  }
  return out;
}
