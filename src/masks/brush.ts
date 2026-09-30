/**
 * Brush masks are stored as STROKES (tiny, resolution independent, persistable, cheap in
 * undo history) and rasterised on demand into a RASTER_SIZE² 8-bit field covering the square
 * [-0.5, 0.5]² of mask space (which contains the whole image).
 *
 * Model per stroke: dabs are stamped along the path at 20 % of the brush diameter; each dab has
 * a soft-edged falloff and opacity `flow`; dabs accumulate with "over" compositing inside the
 * stroke (so flow < 1 builds up as you paint); the stroke is then capped by `density` and either
 * added to the mask (1 − (1−m)(1−t)) or, for the eraser, removed from it (m·(1−t)).
 */
import type { BrushPoint, BrushStroke } from './types';

export const RASTER_SIZE = 1024;
const N = RASTER_SIZE;

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const pressureScale = (p: number) => 0.3 + 0.7 * p; // mouse reports p = 1 → no change

/** Opacity of a dab at distance `r` (0 centre … 1 edge) for a given feather. */
export function falloff(r: number, feather: number): number {
  const f = Math.max(feather, 0.02);
  return r >= 1 ? 0 : 1 - smooth(1 - f, 1, r);
}

function dabs(points: BrushPoint[], radiusPx: number): { x: number; y: number; p: number }[] {
  if (points.length === 0) return [];
  const out = [{ x: (points[0].x + 0.5) * N, y: (points[0].y + 0.5) * N, p: points[0].p }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ax = (a.x + 0.5) * N, ay = (a.y + 0.5) * N, bx = (b.x + 0.5) * N, by = (b.y + 0.5) * N;
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const spacing = Math.max(1, 0.4 * radiusPx * pressureScale((a.p + b.p) / 2));
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, p: a.p + (b.p - a.p) * t });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  return out;
}

/** Apply one stroke to the accumulated mask `buf` (Float32, N×N). */
export function applyStroke(buf: Float32Array, s: BrushStroke): void {
  const radiusPx = s.radius * N;
  const ds = dabs(s.points, radiusPx);
  if (!ds.length) return;
  let x0 = N, y0 = N, x1 = 0, y1 = 0;
  for (const d of ds) {
    const r = radiusPx * pressureScale(d.p);
    x0 = Math.min(x0, Math.floor(d.x - r)); y0 = Math.min(y0, Math.floor(d.y - r));
    x1 = Math.max(x1, Math.ceil(d.x + r)); y1 = Math.max(y1, Math.ceil(d.y + r));
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(N - 1, x1); y1 = Math.min(N - 1, y1);
  if (x1 < x0 || y1 < y0) return;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const acc = new Float32Array(bw * bh);
  for (const d of ds) {
    const r = radiusPx * pressureScale(d.p);
    const flow = s.flow * (s.points.some((p) => p.p < 1) ? 0.4 + 0.6 * d.p : 1);
    const ya = Math.max(y0, Math.floor(d.y - r)), yb = Math.min(y1, Math.ceil(d.y + r));
    const xa = Math.max(x0, Math.floor(d.x - r)), xb = Math.min(x1, Math.ceil(d.x + r));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const dist = Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) / r;
      if (dist >= 1) continue;
      const a = flow * falloff(dist, s.feather);
      const i = (y - y0) * bw + (x - x0);
      acc[i] += (1 - acc[i]) * a;
    }
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = acc[(y - y0) * bw + (x - x0)] * s.density;
    if (t <= 0) continue;
    const i = y * N + x;
    buf[i] = s.erase ? buf[i] * (1 - t) : 1 - (1 - buf[i]) * (1 - t);
  }
}

// ---- caching: strokes arrays are immutable, so identity is a safe cache key
const rasterOf = new WeakMap<BrushStroke[], Uint8Array>();
let base: { strokes: BrushStroke[]; buf: Float32Array } | null = null;

/** Rasterise strokes into an 8-bit field. Reuses earlier work when `strokes` extends the previous call. */
export function rasterize(strokes: BrushStroke[]): Uint8Array {
  const hit = rasterOf.get(strokes);
  if (hit) return hit;
  let buf: Float32Array, from = 0;
  if (base && base.strokes.length <= strokes.length && base.strokes.every((s, i) => s === strokes[i])) {
    buf = base.buf.slice();
    from = base.strokes.length;
  } else buf = new Float32Array(N * N);
  for (let i = from; i < strokes.length; i++) applyStroke(buf, strokes[i]);
  const out = new Uint8Array(N * N);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(buf[i] * 255);
  base = { strokes, buf };
  rasterOf.set(strokes, out);
  return out;
}

export const EMPTY_RASTER = new Uint8Array(N * N);

/** Bilinear sample of a raster at mask-space (mx, my), matching the GPU's LINEAR filtering. Returns 0..1. */
export function sampleRaster(data: Uint8Array, mx: number, my: number): number {
  const fx = (mx + 0.5) * N - 0.5, fy = (my + 0.5) * N - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x: number, y: number) => data[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))] / 255;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}
