/**
 * Auto tone: a HISTOGRAM HEURISTIC, not machine learning. It looks at the distribution of
 * brightness in the unedited photo and sets Exposure, Contrast, Highlights, Shadows, Whites and
 * Blacks so that
 *   - the median lands near mid-grey (encoded 0.46, ≈ 18 % linear),
 *   - the darkest 1 % sits just above black and the brightest 1 % just below white,
 *   - a large dark/bright population gets Shadows/Highlights recovery.
 * Every step is damped and clamped, so it never produces extreme values. The result is a
 * starting point the user then adjusts (and can undo) like any other edit.
 *
 * All percentiles are of ENCODED (sRGB) luminance, 0..1.
 */
import { linearToSrgb, srgbToLinear } from '../color/colorSpace';
import type { AnalysisImage } from './analysis';

export interface AutoToneResult { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number }
export const AUTO_TARGET_MEDIAN = 0.46;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 256-bin histogram of encoded luminance. */
export function lumaHistogram(data: ArrayLike<number>): Float64Array {
  const h = new Float64Array(256);
  for (let i = 0; i < data.length; i += 4) h[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  return h;
}
const percentile = (h: Float64Array, q: number): number => {
  let total = 0; for (const v of h) total += v;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= q * total) return i / 255; }
  return 1;
};
const fractionBelow = (h: Float64Array, x: number) => { let total = 0, n = 0; for (let i = 0; i < 256; i++) { total += h[i]; if (i / 255 < x) n += h[i]; } return n / total; };

/** Histogram after an exposure change of `ev` stops (per-channel clipping ignored: luminance only). */
function shifted(h: Float64Array, ev: number): Float64Array {
  const out = new Float64Array(256), g = Math.pow(2, ev);
  for (let i = 0; i < 256; i++) out[Math.min(255, Math.round(linearToSrgb(srgbToLinear(i / 255) * g) * 255))] += h[i];
  return out;
}

export function autoToneFromHistogram(h: Float64Array): AutoToneResult {
  const med = Math.max(1 / 255, percentile(h, 0.5));
  const exposure = Math.round(clamp(Math.log2(srgbToLinear(AUTO_TARGET_MEDIAN) / srgbToLinear(med)), -2.5, 2.5) * 0.85 * 100) / 100;
  const s = shifted(h, exposure);
  const p1 = percentile(s, 0.01), p99 = percentile(s, 0.99);
  const blacks = p1 > 0.04 ? -Math.round(clamp((p1 - 0.03) * 250, 0, 60)) : p1 < 0.004 ? 10 : 0;
  const whites = p99 < 0.93 ? Math.round(clamp((0.96 - p99) * 300, 0, 60)) : p99 >= 0.99 ? -10 : 0;
  const spread = p99 - p1;
  const contrast = spread < 0.6 ? Math.round(clamp((0.75 - spread) * 100, 0, 40)) : spread > 0.95 ? -10 : 0;
  const shadows = fractionBelow(s, 0.15) > 0.3 ? 25 : fractionBelow(s, 0.15) > 0.15 ? 12 : 0;
  const highlights = 1 - fractionBelow(s, 0.92) > 0.05 ? -30 : 1 - fractionBelow(s, 0.92) > 0.02 ? -15 : 0;
  return { exposure, contrast, highlights, shadows, whites, blacks };
}

export function autoTone(img: AnalysisImage): AutoToneResult {
  return autoToneFromHistogram(lumaHistogram(img.data));
}
