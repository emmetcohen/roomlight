/**
 * Automatic perspective correction ("Upright").
 *
 * 1. `edgeSamples`: Sobel edges of a small greyscale copy; each strong edge pixel becomes a
 *    sample (position, unit direction along the edge, weight = gradient strength).
 * 2. `estimateUpright`: samples whose direction is near-vertical / near-horizontal in the
 *    CURRENT result are assumed to be lines that should be exactly vertical / horizontal.
 *    We search the geometry parameters (straighten, vertical, horizontal) that minimise the
 *    angular error of those lines after the REAL geometry matrix is applied — so sign
 *    conventions can't drift from the renderer. A truncated-quadratic loss ignores outliers
 *    (tree branches, diagonals) and a small penalty prefers gentle corrections.
 * Returns null when too few straight edges are found: nothing is faked.
 */
import { DEFAULT_GEO, geoMatrix, type GeoParams, type Mat3 } from './transform';

export interface EdgeSample { x: number; y: number; dx: number; dy: number; w: number }
export type UprightMode = 'level' | 'vertical' | 'auto' | 'full';

/** Separable [1 2 1]/4 blur (applied twice) so staircase/aliased edges give accurate directions. */
function smooth(src: Float32Array, w: number, h: number): Float32Array {
  let cur = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tmp[y * w + x] = (cur[y * w + Math.max(0, x - 1)] + 2 * cur[y * w + x] + cur[y * w + Math.min(w - 1, x + 1)]) / 4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (tmp[Math.max(0, y - 1) * w + x] + 2 * tmp[y * w + x] + tmp[Math.min(h - 1, y + 1) * w + x]) / 4;
    cur = out;
  }
  return cur;
}

export function edgeSamples(rawGray: Float32Array, w: number, h: number, keep = 0.12, maxSamples = 6000): EdgeSample[] {
  const gray = smooth(rawGray, w, h);
  const mag = new Float32Array(w * h), gxA = new Float32Array(w * h), gyA = new Float32Array(w * h);
  const g = (x: number, y: number) => gray[y * w + x];
  const all: number[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1) - g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1);
    const gy = g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1) - g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1);
    const i = y * w + x;
    gxA[i] = gx; gyA[i] = gy; mag[i] = Math.hypot(gx, gy);
    all.push(mag[i]);
  }
  if (!all.length) return [];
  all.sort((a, b) => a - b);
  const thr = Math.max(all[Math.floor(all.length * (1 - keep))], 1e-4);
  const out: EdgeSample[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    // local maximum along the gradient direction would be ideal; a plain threshold is enough at this scale
    if (mag[i] < thr) continue;
    out.push({ x: x + 0.5 - w / 2, y: y + 0.5 - h / 2, dx: -gyA[i] / mag[i], dy: gxA[i] / mag[i], w: mag[i] });
  }
  if (out.length <= maxSamples) return out;
  const step = out.length / maxSamples;
  return Array.from({ length: maxSamples }, (_, k) => out[Math.floor(k * step)]);
}

/** Direction of a line after a homography (Jacobian at its point). Returns null behind the plane. */
function mapDirection(m: Mat3, s: EdgeSample): [number, number] | null {
  const u = m[0] * s.x + m[1] * s.y + m[2], v = m[3] * s.x + m[4] * s.y + m[5], w = m[6] * s.x + m[7] * s.y + m[8];
  if (w <= 1e-6) return null;
  const w2 = w * w;
  return [
    ((m[0] * w - u * m[6]) * s.dx + (m[1] * w - u * m[7]) * s.dy) / w2,
    ((m[3] * w - v * m[6]) * s.dx + (m[4] * w - v * m[7]) * s.dy) / w2,
  ];
}

const devVertical = (d: [number, number]) => Math.atan2(d[0] * Math.sign(d[1] || 1), Math.abs(d[1]));
const devHorizontal = (d: [number, number]) => Math.atan2(d[1] * Math.sign(d[0] || 1), Math.abs(d[0]));

const RANGE: Partial<Record<keyof GeoParams, [number, number]>> = { straighten: [-10, 10], geoVertical: [-70, 70], geoHorizontal: [-70, 70] };
const REG: Partial<Record<keyof GeoParams, number>> = { straighten: 0.0008, geoVertical: 0.0004, geoHorizontal: 0.0004 }; // penalty per (unit/100)² — tiny

export function estimateUpright(samples: EdgeSample[], sw: number, sh: number, base: GeoParams, mode: UprightMode): Partial<GeoParams> | null {
  const free: (keyof GeoParams)[] = mode === 'level' ? ['straighten'] : mode === 'vertical' ? ['geoVertical'] : mode === 'auto' ? ['straighten', 'geoVertical'] : ['straighten', 'geoVertical', 'geoHorizontal'];
  const M0 = geoMatrix(base, sw, sh);
  const MAXDEV = (20 * Math.PI) / 180;
  const vert: EdgeSample[] = [], horiz: EdgeSample[] = [];
  for (const s of samples) {
    const d = mapDirection(M0, s);
    if (!d) continue;
    if (Math.abs(devVertical(d)) < MAXDEV) vert.push(s);
    else if (Math.abs(devHorizontal(d)) < MAXDEV) horiz.push(s);
  }
  // which line families constrain which parameters
  const useV = true;
  const useH = mode !== 'vertical';
  const V = useV ? vert : [], H = useH ? horiz : [];
  if (V.length + H.length < 40) return null;
  const wsum = [...V, ...H].reduce((a, s) => a + s.w, 0);
  const T = (8 * Math.PI) / 180; // truncation of the loss

  const cost = (g: GeoParams): number => {
    const m = geoMatrix(g, sw, sh);
    let c = 0;
    for (const s of V) { const d = mapDirection(m, s); c += s.w * (d ? Math.min(devVertical(d) ** 2, T * T) : T * T); }
    for (const s of H) { const d = mapDirection(m, s); c += s.w * (d ? Math.min(devHorizontal(d) ** 2, T * T) : T * T); }
    c /= wsum;
    for (const k of free) c += (REG[k] ?? 0) * (g[k] / 100) ** 2;
    return c;
  };

  let cur: GeoParams = { ...base };
  for (const k of free) cur[k] = DEFAULT_GEO[k];
  const startCost = cost(cur);
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const k of free) {
      const [lo, hi] = RANGE[k]!;
      const f = (v: number) => cost({ ...cur, [k]: v });
      // coarse scan, then golden-section inside the best bracket
      let bi = 0, bv = Infinity;
      const N = 40;
      for (let i = 0; i <= N; i++) { const v = f(lo + ((hi - lo) * i) / N); if (v < bv) { bv = v; bi = i; } }
      let a = lo + ((hi - lo) * Math.max(0, bi - 1)) / N, b = lo + ((hi - lo) * Math.min(N, bi + 1)) / N;
      const gr = (Math.sqrt(5) - 1) / 2;
      let c = b - gr * (b - a), d = a + gr * (b - a), fc = f(c), fd = f(d);
      for (let i = 0; i < 40; i++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = f(c); }
        else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = f(d); }
      }
      cur = { ...cur, [k]: (a + b) / 2 };
    }
  }
  if (cost(cur) > startCost * 0.95) return null; // no meaningful improvement
  const out: Partial<GeoParams> = {};
  for (const k of free) out[k] = Math.round(cur[k] * 100) / 100;
  return out;
}

/** Greyscale (perceptual luma) from RGBA8 for edge detection. */
export function grayFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  return g;
}
