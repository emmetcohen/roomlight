/**
 * CPU reference for the blur that feeds texture / clarity / dehaze.
 *
 * Steps (mirrored exactly by the GPU passes): quantity -> box-downsample by `factor`
 * (clamp-to-edge) -> separable Gaussian (clamp-to-edge) -> bilinear upsample at pixel centres.
 * Image buffers are single-channel Float32Array in GL orientation (row 0 = bottom).
 */
import type { BlurSpec } from './derive';

export function kernel(sigma: number): { radius: number; weights: Float32Array } {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const weights = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); weights[i + radius] = v; sum += v; }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return { radius, weights };
}

export function downsample(src: Float32Array, w: number, h: number, f: number, lw: number, lh: number): Float32Array {
  if (f === 1) return src;
  const out = new Float32Array(lw * lh);
  const inv = 1 / (f * f);
  for (let J = 0; J < lh; J++) for (let I = 0; I < lw; I++) {
    let s = 0;
    for (let fy = 0; fy < f; fy++) for (let fx = 0; fx < f; fx++) s += src[Math.min(J * f + fy, h - 1) * w + Math.min(I * f + fx, w - 1)];
    out[J * lw + I] = s * inv;
  }
  return out;
}

export function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const { radius, weights } = kernel(sigma);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += weights[k + radius] * src[y * w + Math.min(Math.max(x + k, 0), w - 1)];
    tmp[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += weights[k + radius] * tmp[Math.min(Math.max(y + k, 0), h - 1) * w + x];
    out[y * w + x] = s;
  }
  return out;
}

/** Blurred field at low resolution, ready for `sampleBlur`. */
export function blurField(q: Float32Array, w: number, h: number, spec: BlurSpec): Float32Array {
  return gaussian(downsample(q, w, h, spec.factor, spec.lw, spec.lh), spec.lw, spec.lh, spec.sigmaLow);
}

/** Bilinear sample of a low-res field at full-res pixel (x, y) (GL orientation). */
export function sampleBlur(field: Float32Array, spec: BlurSpec, x: number, y: number): number {
  const u = (x + 0.5) / spec.factor - 0.5, v = (y + 0.5) / spec.factor - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fx = u - i0, fy = v - j0;
  const c = (i: number, j: number) => field[Math.min(Math.max(j, 0), spec.lh - 1) * spec.lw + Math.min(Math.max(i, 0), spec.lw - 1)];
  return (c(i0, j0) * (1 - fx) + c(i0 + 1, j0) * fx) * (1 - fy) + (c(i0, j0 + 1) * (1 - fx) + c(i0 + 1, j0 + 1) * fx) * fy;
}
