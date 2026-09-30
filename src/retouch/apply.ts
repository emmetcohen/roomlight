/**
 * Applies retouch spots to decoded source pixels (RGBA8, row 0 = top). Pure and deterministic.
 * The input is never modified: the result is a copy (or the very same array when no spot
 * would change anything, so callers can skip re-uploading).
 *
 * All blending happens in linear light; only pixels inside a spot are re-encoded to 8-bit.
 * Sequential: later spots see the result of earlier ones.
 *
 * Heal — seamless cloning by boundary interpolation:
 *   For a target pixel p inside the circle of radius R and centre c, with source offset d:
 *       healed(p) = S(p + d) + m(p)
 *   where the correction m is the smooth interpolation of the boundary mismatch
 *       e_i = T(b_i) − S(b_i + d)            (b_i: N points on a circle just outside the spot)
 *   using mean-value coordinates (Floater 2003):
 *       m(p) = Σ λ_i(p) e_i ,   λ_i ∝ (tan(α_{i−1}/2) + tan(α_i/2)) / |b_i − p|
 *   α_i = angle at p between b_i and b_{i+1}. m equals e_i on the boundary, so the patch
 *   meets its surroundings without a seam, and inside it adds only low-frequency colour and
 *   brightness — the copied texture is kept. Result = mix(T(p), healed(p), w(p)·opacity) with
 *   w a smooth feathered disc.
 *
 * Remove — automatic source. Candidate centres lie on rings around the target (non-overlapping).
 * Score = Σ |T(q_j) − S(q_j + d)|² over 32 points on two rings just outside the target, plus a
 * small penalty on the candidate's own internal variance (so a patch with a blemish of its own
 * loses). The lowest score wins; the heal then runs with that source. Deterministic.
 */
import type { Spot } from './types';

const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const enc8 = (x: number) => { const v = x <= 0 ? 0 : x >= 1 ? 1 : x; return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); };

interface Buf { data: Uint8ClampedArray; w: number; h: number }

/** Bilinear read at continuous pixel coordinates (pixel centres at +0.5), clamp to edge, linear light. */
function sample(b: Buf, fx: number, fy: number, out: Float32Array, o = 0): void {
  const x = fx - 0.5, y = fy - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const cx0 = Math.min(b.w - 1, Math.max(0, x0)), cx1 = Math.min(b.w - 1, Math.max(0, x0 + 1));
  const cy0 = Math.min(b.h - 1, Math.max(0, y0)), cy1 = Math.min(b.h - 1, Math.max(0, y0 + 1));
  const i00 = (cy0 * b.w + cx0) * 4, i10 = (cy0 * b.w + cx1) * 4, i01 = (cy1 * b.w + cx0) * 4, i11 = (cy1 * b.w + cx1) * 4;
  for (let c = 0; c < 3; c++) {
    out[o + c] = (LIN[b.data[i00 + c]] * (1 - tx) + LIN[b.data[i10 + c]] * tx) * (1 - ty) + (LIN[b.data[i01 + c]] * (1 - tx) + LIN[b.data[i11 + c]] * tx) * ty;
  }
}

const lum = (a: Float32Array, o: number) => 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2];

const BOUNDARY_N = 32;
const SEARCH_ANGLES = 16;
const SEARCH_RADII = [2.3, 3.2, 4.4, 6];

export interface Resolved { sx: number; sy: number; /** false when no usable source patch exists (remove only) */ ok: boolean }
export interface RetouchResult {
  /** Retouched RGBA8 (same array as the input when nothing changed). */
  data: Uint8ClampedArray;
  /** Source centre actually used for each spot, mask space (auto-found for `remove`). */
  resolved: Map<string, Resolved>;
  changed: boolean;
}

/** Best source centre (pixel coords) for a target at (cx, cy) with radius R, or null. */
export function findSource(b: Buf, cx: number, cy: number, R: number): { x: number; y: number } | null {
  const ring: [number, number][] = [];
  for (const k of [1.15, 1.45]) for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2 + (k > 1.3 ? Math.PI / 16 : 0); ring.push([Math.cos(t) * R * k, Math.sin(t) * R * k]); }
  const tv = new Float32Array(ring.length * 3);
  ring.forEach(([dx, dy], i) => sample(b, cx + dx, cy + dy, tv, i * 3));
  const s = new Float32Array(3);
  const inner = new Float32Array(9 * 3);
  let best: { x: number; y: number } | null = null, bestScore = Infinity;
  const m = R * 1.6 + 1; // the candidate's surrounding ring must stay inside the picture
  for (const kr of SEARCH_RADII) for (let a = 0; a < SEARCH_ANGLES; a++) {
    const t = (a / SEARCH_ANGLES) * Math.PI * 2 + kr * 0.37;
    const x = cx + Math.cos(t) * R * kr, y = cy + Math.sin(t) * R * kr;
    if (x < m || y < m || x > b.w - m || y > b.h - m) continue;
    let score = 0;
    for (let i = 0; i < ring.length; i++) {
      sample(b, x + ring[i][0], y + ring[i][1], s, 0);
      for (let c = 0; c < 3; c++) { const d = tv[i * 3 + c] - s[c]; score += d * d; }
    }
    // the candidate's own texture: prefer clean patches (a blemish copied in is worse than smooth skin)
    sample(b, x, y, inner, 0);
    for (let i = 0; i < 8; i++) { const t2 = (i / 8) * Math.PI * 2; sample(b, x + Math.cos(t2) * R * 0.6, y + Math.sin(t2) * R * 0.6, inner, (i + 1) * 3); }
    let mu = 0; for (let i = 0; i < 9; i++) mu += lum(inner, i * 3); mu /= 9;
    let v = 0; for (let i = 0; i < 9; i++) v += (lum(inner, i * 3) - mu) ** 2; v /= 9;
    score += 0.3 * ring.length * v;
    if (score < bestScore) { bestScore = score; best = { x, y }; }
  }
  return best;
}

/** Smooth feathered disc weight: 1 inside R·(1−f), 0 at R (smoothstep between). */
function weight(d: number, R: number, feather: number): number {
  const inner = R * (1 - feather);
  if (d <= inner) return 1;
  if (d >= R) return 0;
  const t = (R - d) / (R - inner);
  return t * t * (3 - 2 * t);
}

export function applySpots(src: Uint8ClampedArray, w: number, h: number, spots: Spot[]): RetouchResult {
  const resolved = new Map<string, Resolved>();
  const active = spots.filter((s) => s.enabled && s.opacity > 0 && s.r > 0);
  if (!active.length) {
    for (const s of spots) resolved.set(s.id, { sx: s.sx, sy: s.sy, ok: true });
    return { data: src, resolved, changed: false };
  }
  const L = Math.max(w, h);
  const buf: Buf = { data: new Uint8ClampedArray(src), w, h };
  let changed = false;
  const t = new Float32Array(3), sv = new Float32Array(3);

  for (const s of spots) {
    if (!s.enabled || s.opacity <= 0) { resolved.set(s.id, { sx: s.sx, sy: s.sy, ok: true }); continue; }
    const cx = w / 2 + s.x * L, cy = h / 2 + s.y * L, R = Math.max(0.75, s.r * L);
    let scx = w / 2 + s.sx * L, scy = h / 2 + s.sy * L;
    if (s.kind === 'remove') {
      const f = findSource(buf, cx, cy, R);
      if (!f) { resolved.set(s.id, { sx: s.x, sy: s.y, ok: false }); continue; }
      scx = f.x; scy = f.y;
    }
    resolved.set(s.id, { sx: (scx - w / 2) / L, sy: (scy - h / 2) / L, ok: true });
    const ox = scx - cx, oy = scy - cy;
    if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) continue; // source == target: nothing to do

    // boundary mismatch for heal/remove
    const heal = s.kind !== 'clone';
    const BR = R * 1.01 + 0.5;
    const bx = new Float64Array(BOUNDARY_N), by = new Float64Array(BOUNDARY_N), e = new Float32Array(BOUNDARY_N * 3);
    if (heal) {
      for (let i = 0; i < BOUNDARY_N; i++) {
        const a = (i / BOUNDARY_N) * Math.PI * 2;
        bx[i] = Math.cos(a) * BR; by[i] = Math.sin(a) * BR;
        sample(buf, cx + bx[i], cy + by[i], t); sample(buf, cx + bx[i] + ox, cy + by[i] + oy, sv);
        for (let c = 0; c < 3; c++) e[i * 3 + c] = t[c] - sv[c];
      }
    }

    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
    const pend: number[] = []; // [index, r, g, b, ...] computed first, written after (source may overlap target)
    const rr = new Float64Array(BOUNDARY_N), tn = new Float64Array(BOUNDARY_N);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      const d = Math.hypot(px, py);
      const wgt = weight(d, R, s.feather) * s.opacity;
      if (wgt <= 0) continue;
      sample(buf, x + 0.5 + ox, y + 0.5 + oy, sv);
      let r = sv[0], g = sv[1], bl = sv[2];
      if (heal) {
        // mean-value coordinates of p w.r.t. the boundary polygon
        let exact = -1;
        for (let i = 0; i < BOUNDARY_N; i++) { rr[i] = Math.hypot(bx[i] - px, by[i] - py); if (rr[i] < 1e-7) exact = i; }
        let m0 = 0, m1 = 0, m2 = 0;
        if (exact >= 0) { m0 = e[exact * 3]; m1 = e[exact * 3 + 1]; m2 = e[exact * 3 + 2]; }
        else {
          for (let i = 0; i < BOUNDARY_N; i++) {
            const j = (i + 1) % BOUNDARY_N;
            const ax = bx[i] - px, ay = by[i] - py, cxx = bx[j] - px, cyy = by[j] - py;
            tn[i] = (ax * cyy - ay * cxx) / (rr[i] * rr[j] + ax * cxx + ay * cyy); // tan(α_i / 2)
          }
          let sw = 0;
          for (let i = 0; i < BOUNDARY_N; i++) {
            const wi = (tn[(i + BOUNDARY_N - 1) % BOUNDARY_N] + tn[i]) / rr[i];
            sw += wi; m0 += wi * e[i * 3]; m1 += wi * e[i * 3 + 1]; m2 += wi * e[i * 3 + 2];
          }
          m0 /= sw; m1 /= sw; m2 /= sw;
        }
        r = Math.max(0, r + m0); g = Math.max(0, g + m1); bl = Math.max(0, bl + m2);
      }
      const o = (y * w + x) * 4;
      sample(buf, x + 0.5, y + 0.5, t);
      pend.push(o, t[0] + (r - t[0]) * wgt, t[1] + (g - t[1]) * wgt, t[2] + (bl - t[2]) * wgt);
    }
    for (let i = 0; i < pend.length; i += 4) {
      const o = pend[i];
      const nr = enc8(pend[i + 1]), ng = enc8(pend[i + 2]), nb = enc8(pend[i + 3]);
      if (nr !== buf.data[o] || ng !== buf.data[o + 1] || nb !== buf.data[o + 2]) changed = true;
      buf.data[o] = nr; buf.data[o + 1] = ng; buf.data[o + 2] = nb;
    }
  }
  return { data: changed ? buf.data : src, resolved, changed };
}
