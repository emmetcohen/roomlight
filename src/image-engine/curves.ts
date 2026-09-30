/**
 * Tone curves: control points -> smooth monotone cubic (PCHIP) -> 1D lookup table.
 *
 * A curve maps INPUT (x) to OUTPUT (y), both in encoded (display-referred, sRGB-OETF) units
 * [0,1]. PCHIP (Fritsch–Carlson) is C¹-smooth and never overshoots between points, so a
 * monotone set of points gives a monotone curve — no wobble or ringing.
 *
 * End points are the black point (first) and white point (last). They can move in both
 * axes; outside the first/last x the curve extends flat (input black/white point clipping).
 */

export interface CurvePoint {
  x: number;
  y: number;
}
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';
export type ToneCurves = Record<CurveChannel, CurvePoint[]>;

export const CURVE_CHANNELS: CurveChannel[] = ['rgb', 'r', 'g', 'b'];
export const LUT_SIZE = 1024;
/** Minimum x distance between neighbouring points (keeps the spline well-defined). */
export const MIN_GAP = 0.004;

export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
export const defaultCurves = (): ToneCurves => ({ rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() });

export function isIdentityCurve(pts: CurvePoint[]): boolean {
  return pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;
}
export function curvesAreIdentity(c: ToneCurves): boolean {
  return CURVE_CHANNELS.every((ch) => isIdentityCurve(c[ch]));
}
export function curvesEqual(a: ToneCurves, b: ToneCurves): boolean {
  if (a === b) return true;
  for (const ch of CURVE_CHANNELS) {
    const p = a[ch], q = b[ch];
    if (p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++) if (p[i].x !== q[i].x || p[i].y !== q[i].y) return false;
  }
  return true;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Validate/repair untrusted points (from storage or import): sorted, in range, ≥ 2 points. */
export function normalizeCurve(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return identityCurve();
  const pts = raw
    .filter((p): p is CurvePoint => !!p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of pts) if (!out.length || p.x - out[out.length - 1].x >= MIN_GAP) out.push(p);
  return out.length >= 2 ? out : identityCurve();
}
export function normalizeCurves(raw: unknown): ToneCurves {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<CurveChannel, unknown>>;
  return { rgb: normalizeCurve(r.rgb), r: normalizeCurve(r.r), g: normalizeCurve(r.g), b: normalizeCurve(r.b) };
}

/** Build an evaluator f(x) for a point set. */
export function makeCurve(pts: CurvePoint[]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = new Array<number>(n).fill(0);
  if (n === 2) { m[0] = m[1] = d[0]; }
  else {
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] > 0) {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); // weighted harmonic mean
      } else m[i] = 0;
    }
    const end = (h0: number, h1: number, d0: number, d1: number) => {
      let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(v) !== Math.sign(d0)) v = 0;
      else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > 3 * Math.abs(d0)) v = 3 * d0;
      return v;
    };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
    return clamp01(v);
  };
}

export const evalCurve = (pts: CurvePoint[], x: number) => makeCurve(pts)(x);

/**
 * Compose the four curves into one RGB lookup table: out_c = curve_c(master(x)).
 * Layout: LUT_SIZE texels × RGBA (A unused = 1), ready to upload as an RGBA16F texture.
 */
export function buildLut(curves: ToneCurves): Float32Array {
  const master = makeCurve(curves.rgb), fr = makeCurve(curves.r), fg = makeCurve(curves.g), fb = makeCurve(curves.b);
  const lut = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const m = master(i / (LUT_SIZE - 1));
    lut[i * 4] = fr(m); lut[i * 4 + 1] = fg(m); lut[i * 4 + 2] = fb(m); lut[i * 4 + 3] = 1;
  }
  return lut;
}

/** Linear interpolation in the LUT (what the GPU's LINEAR filtering does). x clamps to [0,1]. */
export function sampleLut(lut: Float32Array, channel: 0 | 1 | 2, x: number): number {
  const pos = clamp01(x) * (LUT_SIZE - 1);
  const i0 = Math.min(Math.floor(pos), LUT_SIZE - 2);
  const f = pos - i0;
  return lut[i0 * 4 + channel] * (1 - f) + lut[(i0 + 1) * 4 + channel] * f;
}

// ------------------------------------------------------------------ editing operations (pure)

/** Insert a point; if one already sits within MIN_GAP of x, return that one instead. */
export function addPoint(pts: CurvePoint[], x: number, y: number): { points: CurvePoint[]; index: number } {
  x = clamp01(x); y = clamp01(y);
  const near = pts.findIndex((p) => Math.abs(p.x - x) < MIN_GAP);
  if (near >= 0) return { points: pts, index: near };
  const points = [...pts, { x, y }].sort((a, b) => a.x - b.x);
  return { points, index: points.findIndex((p) => p.x === x && p.y === y) };
}

/** Move point i, keeping order and MIN_GAP to neighbours. End points stay the first/last. */
export function movePoint(pts: CurvePoint[], i: number, x: number, y: number): CurvePoint[] {
  const lo = i === 0 ? 0 : pts[i - 1].x + MIN_GAP;
  const hi = i === pts.length - 1 ? 1 : pts[i + 1].x - MIN_GAP;
  const nx = Math.min(Math.max(x, lo), Math.max(lo, hi));
  const out = pts.slice();
  out[i] = { x: nx, y: clamp01(y) };
  return out;
}

/** Remove an interior point. The black and white points cannot be removed. */
export function removePoint(pts: CurvePoint[], i: number): CurvePoint[] {
  if (i <= 0 || i >= pts.length - 1) return pts;
  return pts.filter((_, j) => j !== i);
}
