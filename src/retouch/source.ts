/**
 * The pixels the renderer reads: the decoded original with retouch spots applied.
 * Derived on demand, cached by identity (same original + same spot list = same result), and
 * never written anywhere — the original file and bitmap are not touched.
 */
import { applySpots, type RetouchResult } from './apply';
import type { Spot } from './types';

export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

/** RGBA8 pixels of a decoded bitmap. */
export function readPixels(bitmap: ImageBitmap): Pixels {
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height }) : new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: d.data, width: d.width, height: d.height };
}

let last: { pixels: Pixels; spots: Spot[]; result: RetouchResult } | null = null;

/** Retouched pixels for (pixels, spots); `result.data === pixels.data` when nothing changes. */
export function retouchedPixels(pixels: Pixels, spots: Spot[]): RetouchResult {
  if (last && last.pixels === pixels && last.spots === spots) return last.result;
  const result = applySpots(pixels.data, pixels.width, pixels.height, spots);
  last = { pixels, spots, result };
  return result;
}
