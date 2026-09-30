/**
 * Detail: input sharpening and noise reduction. A pre-pass over the SOURCE pixels (after retouch
 * spots, before geometry and every tonal adjustment), exactly where raw converters apply them.
 * Pure and deterministic; the input is never modified. Preview, 1:1 view and export all call
 * this same function, so they agree.
 *
 * Working space: encoded sRGB → Y (BT.709 luma), Cb, Cr (each ±0.5·255 scale):
 *     Y = 0.2126 R + 0.7152 G + 0.0722 B,  Cb = (B − Y)/1.8556,  Cr = (R − Y)/1.5748
 * `scale` = pixels here ÷ pixels of the original (1 for full size). Radii are given in ORIGINAL
 * pixels, so a scaled preview looks like the full-size result.
 *
 * Noise reduction (edge-preserving, O(N) guided filters — He, Sun, Tang 2010):
 *   GF(I,p): a = cov(I,p)/(var(I)+ε),  b = mean(p) − a·mean(I),  q = mean(a)·I + mean(b)   (box means, radius r)
 *   Luminance: Y_s = GF(Y,Y) with ε = σ², σ = 25·Luminance/100 levels, r = max(1, round((1 + 2·L)·scale)).
 *     Detail restores what the filter removed: Y₁ = Y_s + ρ·(Y − Y_s), ρ = 0.6·(Detail/100)².
 *     Contrast restores local contrast of the smoothed picture: Y₂ = Y₁ + 0.6·C·(Y_s − box₄(Y_s)).
 *   Colour: Cb, Cr are filtered at HALF resolution by a joint guided filter whose guide is the
 *     3-channel (Y, Cb, Cr) image (so colour never crosses a brightness OR a colour edge): ε = (4 + 36·(1 − Detail/100))², radius from Smoothness,
 *     then upsampled bilinearly; C' = C + Color/100·(C_s − C).
 * Sharpening (unsharp mask on luma): D = Y − G_σ*Y, σ = max(0.4, Radius·scale).
 *     Detail controls halo suppression: g = D_soft + (D − D_soft)·Detail/100, D_soft = D / (1 + |D|/12).
 *     Masking limits it to edges: w = smoothstep(0.3·t, t, |∇Y|), t = 30·Masking/100 (w = 1 when Masking = 0),
 *     smoothed by a 3×3 box. Y' = Y + (Amount/100)·w·g.
 * Local (per-mask) Sharpness/Noise blend toward a fixed sharpened / denoised version of the image by the mask value.
 */
import { smoothstep } from '../color/colorSpace';
import { srgbToLinear } from '../color/colorSpace';
import { flattenMasks, maskValue } from '../masks/evaluate';
import type { Mask } from '../masks/types';

export interface DetailParams {
  sharpAmount: number; sharpRadius: number; sharpDetail: number; sharpMasking: number;
  nrLuma: number; nrLumaDetail: number; nrLumaContrast: number; nrColor: number; nrColorDetail: number; nrColorSmooth: number;
}
export const DETAIL_KEYS: (keyof DetailParams)[] = ['sharpAmount', 'sharpRadius', 'sharpDetail', 'sharpMasking', 'nrLuma', 'nrLumaDetail', 'nrLumaContrast', 'nrColor', 'nrColorDetail', 'nrColorSmooth'];
export const NO_DETAIL: DetailParams = { sharpAmount: 0, sharpRadius: 1, sharpDetail: 25, sharpMasking: 0, nrLuma: 0, nrLumaDetail: 50, nrLumaContrast: 0, nrColor: 0, nrColorDetail: 50, nrColorSmooth: 50 };

export const globalDetailActive = (p: DetailParams): boolean => p.sharpAmount > 0 || p.nrLuma > 0 || p.nrColor > 0;
const maskDetailOf = (m: Mask) => (m.enabled ? (m.adjust.sharpness ?? 0) !== 0 || (m.adjust.noise ?? 0) !== 0 : false);
export const maskDetailActive = (masks: Mask[]): boolean => masks.some(maskDetailOf);
export const detailActive = (p: DetailParams, masks: Mask[]): boolean => globalDetailActive(p) || maskDetailActive(masks);

// ------------------------------------------------------------------ box / gaussian / guided filter on float planes
/** Box mean of radius r, replicate edges. */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Gaussian blur approximated by three box blurs (Kovesi / Ivan Kutskir box sizes for σ). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const N = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / N + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - N * wl * wl - 4 * N * wl - 3 * N) / (-4 * wl - 4));
  let cur = src;
  for (let i = 0; i < N; i++) cur = boxMean(cur, w, h, Math.max(0, ((i < m ? wl : wu) - 1) / 2));
  return cur;
}

const mul = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i]; return o; };

/** Guided filter: smooth `p` guided by `I` (I === p for self-guided edge-preserving smoothing). */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const mI = boxMean(I, w, h, r), mII = boxMean(mul(I, I), w, h, r);
  const same = I === p;
  const mP = same ? mI : boxMean(p, w, h, r), mIP = same ? mII : boxMean(mul(I, p), w, h, r);
  const a = new Float32Array(I.length), b = new Float32Array(I.length);
  for (let i = 0; i < a.length; i++) {
    const varI = Math.max(0, mII[i] - mI[i] * mI[i]), cov = mIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps); b[i] = mP[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(I.length);
  for (let i = 0; i < q.length; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/**
 * Guided filter with a 3-channel guide (He et al.): the guide (Y, Cb, Cr) sees colour edges as well as
 * brightness edges, so colour smoothing stops at both. a = (Σ + εI)⁻¹ cov(G, p), q = mean(a)·G + mean(b).
 */
export function guidedFilter3(G: Float32Array[], targets: Float32Array[], w: number, h: number, r: number, eps: number): Float32Array[] {
  const n = w * h, mG = G.map((g) => boxMean(g, w, h, r));
  const cov: Float32Array[] = [];
  const idx: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  for (const [i, j] of idx) { const m = boxMean(mul(G[i], G[j]), w, h, r), c = new Float32Array(n); for (let k = 0; k < n; k++) c[k] = m[k] - mG[i][k] * mG[j][k]; cov.push(c); }
  // inverse of the (regularised) 3×3 covariance per pixel, stored as 6 planes
  const inv: Float32Array[] = idx.map(() => new Float32Array(n));
  for (let k = 0; k < n; k++) {
    const a = cov[0][k] + eps, b = cov[1][k], c = cov[2][k], d = cov[3][k] + eps, e = cov[4][k], f = cov[5][k] + eps;
    const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
    const id = 1 / (det || 1e-9);
    inv[0][k] = (d * f - e * e) * id; inv[1][k] = (c * e - b * f) * id; inv[2][k] = (b * e - c * d) * id;
    inv[3][k] = (a * f - c * c) * id; inv[4][k] = (b * c - a * e) * id; inv[5][k] = (a * d - b * b) * id;
  }
  return targets.map((p) => {
    const mP = boxMean(p, w, h, r);
    const covGp = G.map((g) => { const m = boxMean(mul(g, p), w, h, r), c = new Float32Array(n); for (let k = 0; k < n; k++) c[k] = m[k]; return c; });
    const a0 = new Float32Array(n), a1 = new Float32Array(n), a2 = new Float32Array(n), b = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const c0 = covGp[0][k] - mG[0][k] * mP[k], c1 = covGp[1][k] - mG[1][k] * mP[k], c2 = covGp[2][k] - mG[2][k] * mP[k];
      a0[k] = inv[0][k] * c0 + inv[1][k] * c1 + inv[2][k] * c2;
      a1[k] = inv[1][k] * c0 + inv[3][k] * c1 + inv[4][k] * c2;
      a2[k] = inv[2][k] * c0 + inv[4][k] * c1 + inv[5][k] * c2;
      b[k] = mP[k] - a0[k] * mG[0][k] - a1[k] * mG[1][k] - a2[k] * mG[2][k];
    }
    const m0 = boxMean(a0, w, h, r), m1 = boxMean(a1, w, h, r), m2 = boxMean(a2, w, h, r), mb = boxMean(b, w, h, r);
    const q = new Float32Array(n);
    for (let k = 0; k < n; k++) q[k] = m0[k] * G[0][k] + m1[k] * G[1][k] + m2[k] * G[2][k] + mb[k];
    return q;
  });
}

function downsample2(src: Float32Array, w: number, h: number): { d: Float32Array; w: number; h: number } {
  const dw = Math.ceil(w / 2), dh = Math.ceil(h / 2), d = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x1 = Math.min(w - 1, 2 * x + 1), y1 = Math.min(h - 1, 2 * y + 1);
    d[y * dw + x] = (src[2 * y * w + 2 * x] + src[2 * y * w + x1] + src[y1 * w + 2 * x] + src[y1 * w + x1]) / 4;
  }
  return { d, w: dw, h: dh };
}
function upsample2(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      o[y * w + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return o;
}

// ------------------------------------------------------------------ the pass
interface Planes { Y: Float32Array; Cb: Float32Array; Cr: Float32Array }
function toPlanes(d: Uint8ClampedArray, n: number): Planes {
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y; Cb[i] = (b - y) / 1.8556; Cr[i] = (r - y) / 1.5748;
  }
  return { Y, Cb, Cr };
}
function fromPlanes(p: Planes, src: Uint8ClampedArray, out: Uint8ClampedArray, n: number) {
  for (let i = 0; i < n; i++) {
    const y = p.Y[i], r = y + 1.5748 * p.Cr[i], b = y + 1.8556 * p.Cb[i], g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = src[i * 4 + 3];
  }
}

function denoise(pl: Planes, w: number, h: number, p: DetailParams, scale: number) {
  if (p.nrLuma > 0) {
    const a = p.nrLuma / 100, sigma = 25 * a, r = Math.max(1, Math.round((1 + 2 * a) * scale));
    const Ys = guidedFilter(pl.Y, pl.Y, w, h, r, sigma * sigma);
    const rho = 0.6 * (p.nrLumaDetail / 100) ** 2;
    const Y1 = new Float32Array(pl.Y.length);
    for (let i = 0; i < Y1.length; i++) Y1[i] = Ys[i] + rho * (pl.Y[i] - Ys[i]);
    if (p.nrLumaContrast > 0) {
      const base = boxMean(Ys, w, h, Math.max(2, Math.round(4 * scale))), c = 0.6 * (p.nrLumaContrast / 100);
      for (let i = 0; i < Y1.length; i++) Y1[i] += c * (Ys[i] - base[i]);
    }
    pl.Y = Y1;
  }
  if (p.nrColor > 0) {
    const a = p.nrColor / 100, eps = (4 + 36 * (1 - p.nrColorDetail / 100)) ** 2;
    const r = Math.max(1, Math.round(((2 + 8 * (p.nrColorSmooth / 100)) * scale) / 2));
    const yh = downsample2(pl.Y, w, h), cb = downsample2(pl.Cb, w, h), cr = downsample2(pl.Cr, w, h);
    // the guide is (Y, Cb, Cr) with the chroma lightly pre-blurred so its own noise does not count as an edge
    const guide = [yh.d, gaussianBlur(cb.d, yh.w, yh.h, 1), gaussianBlur(cr.d, yh.w, yh.h, 1)];
    const [fcb, fcr] = guidedFilter3(guide, [cb.d, cr.d], yh.w, yh.h, r, eps).map((f) => upsample2(f, yh.w, yh.h, w, h));
    for (const [key, s] of [['Cb', fcb], ['Cr', fcr]] as const) {
      const c = pl[key], o = new Float32Array(c.length);
      for (let i = 0; i < o.length; i++) o[i] = c[i] + a * (s[i] - c[i]);
      pl[key] = o;
    }
  }
}

function sharpen(pl: Planes, w: number, h: number, p: DetailParams, scale: number) {
  if (p.sharpAmount <= 0) return;
  const Y = pl.Y, B = gaussianBlur(Y, w, h, Math.max(0.4, p.sharpRadius * scale));
  let edge: Float32Array | null = null;
  if (p.sharpMasking > 0) {
    const t = (30 * p.sharpMasking) / 100, raw = new Float32Array(Y.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = Y[y * w + Math.min(w - 1, x + 1)] - Y[y * w + Math.max(0, x - 1)], gy = Y[Math.min(h - 1, y + 1) * w + x] - Y[Math.max(0, y - 1) * w + x];
      raw[i] = smoothstep(0.3 * t, t, (Math.abs(gx) + Math.abs(gy)) / 2);
    }
    edge = boxMean(raw, w, h, 1);
  }
  const k = p.sharpAmount / 100, d = p.sharpDetail / 100, out = new Float32Array(Y.length);
  for (let i = 0; i < out.length; i++) {
    const D = Y[i] - B[i], soft = D / (1 + Math.abs(D) / 12);
    out[i] = Y[i] + k * (edge ? edge[i] : 1) * (soft + (D - soft) * d);
  }
  pl.Y = out;
}

/** Global Detail pass. Returns `src` itself when nothing is active. */
export function applyDetail(src: Uint8ClampedArray, w: number, h: number, p: DetailParams, scale = 1): Uint8ClampedArray {
  if (!globalDetailActive(p)) return src;
  const n = w * h, pl = toPlanes(src, n), out = new Uint8ClampedArray(src.length);
  denoise(pl, w, h, p, scale);
  sharpen(pl, w, h, p, scale);
  fromPlanes(pl, src, out, n);
  return out;
}

const LOCAL_SHARP: DetailParams = { ...NO_DETAIL, sharpAmount: 100, sharpRadius: 1, sharpDetail: 50, sharpMasking: 0 };
const LOCAL_NOISE: DetailParams = { ...NO_DETAIL, nrLuma: 60, nrLumaDetail: 30, nrColor: 60, nrColorDetail: 40, nrColorSmooth: 50 };

/** Per-mask Sharpness / Noise: blend toward a sharpened / denoised copy by each mask's value. */
export function applyMaskDetail(base: Uint8ClampedArray, w: number, h: number, masks: Mask[], scale = 1): Uint8ClampedArray {
  if (!maskDetailActive(masks)) return base;
  const t = flattenMasks(masks);
  const items = t.source.map((mi, i) => ({ i, s: (masks[mi].adjust.sharpness ?? 0) / 100, n: (masks[mi].adjust.noise ?? 0) / 100 })).filter((x) => x.s !== 0 || x.n !== 0);
  if (!items.length) return base;
  const needS = items.some((x) => x.s !== 0), needN = items.some((x) => x.n !== 0);
  const S = needS ? applyDetail(base, w, h, LOCAL_SHARP, scale) : base, N = needN ? applyDetail(base, w, h, LOCAL_NOISE, scale) : base;
  const out = new Uint8ClampedArray(base);
  const L = Math.max(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const c0: [number, number, number] = [srgbToLinear(base[o] / 255), srgbToLinear(base[o + 1] / 255), srgbToLinear(base[o + 2] / 255)];
    const mx = (x + 0.5 - w / 2) / L, my = (y + 0.5 - h / 2) / L;
    let ds = 0, dn = 0;
    for (const it of items) {
      const m = maskValue(t, it.i, mx, my, c0);
      if (m <= 0) continue;
      ds += m * it.s; dn += m * it.n;
    }
    if (ds === 0 && dn === 0) continue;
    // positive = toward sharpened / denoised; negative Sharpness softens (toward the local mean via reflection of the sharpening delta)
    for (let c = 0; c < 3; c++) out[o + c] = base[o + c] + ds * (S[o + c] - base[o + c]) + dn * (N[o + c] - base[o + c]);
  }
  return out;
}

/** Everything the pre-pass does: global Detail, then per-mask Detail. `src` is returned unchanged when inactive. */
export function applyAllDetail(src: Uint8ClampedArray, w: number, h: number, p: DetailParams, masks: Mask[], scale = 1): Uint8ClampedArray {
  return applyMaskDetail(applyDetail(src, w, h, p, scale), w, h, masks, scale);
}

export const detailParamsOf = (p: Record<string, unknown>): DetailParams => {
  const o = { ...NO_DETAIL } as Record<string, number>;
  for (const k of DETAIL_KEYS) if (typeof p[k] === 'number') o[k] = p[k] as number;
  return o as unknown as DetailParams;
};
