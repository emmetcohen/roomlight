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

// One cached result per source (the preview and a full-resolution copy can both be in use).
const cache = new WeakMap<Pixels, { spots: Spot[]; result: RetouchResult }>();

/** Retouched pixels for (pixels, spots); `result.data === pixels.data` when nothing changes. */
export function retouchedPixels(pixels: Pixels, spots: Spot[]): RetouchResult {
  const hit = cache.get(pixels);
  if (hit && hit.spots === spots) return hit.result;
  const result = applySpots(pixels.data, pixels.width, pixels.height, spots);
  cache.set(pixels, { spots, result });
  return result;
}

const pixelCache = new WeakMap<ImageBitmap, Pixels>();
/** Pixels of a bitmap, read once. */
export function pixelsOf(bitmap: ImageBitmap): Pixels {
  let p = pixelCache.get(bitmap);
  if (!p) { p = readPixels(bitmap); pixelCache.set(bitmap, p); }
  return p;
}
