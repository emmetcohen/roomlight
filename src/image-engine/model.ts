/**
 * Mathematical model of the Phase-1 adjustments (CPU reference implementation).
 *
 * This file is the *specification*. The GLSL in glsl.ts mirrors it line for line, and
 * `npm run verify:gpu` renders a test image through both and compares them.
 * See docs/image-engine.md for the derivations.
 */
import { Vec3, clamp, linearToSrgb, luminance, smoothstep, srgbToLinear } from '../color/colorSpace';
import type { EditParams } from './params';

// ---------------------------------------------------------------- constants (shared with GLSL)

/** Stops of red/blue gain at temperature = ±100. */
export const TEMP_STOPS = 0.4;
/** Stops of green gain at tint = ±100 (positive tint = magenta = less green). */
export const TINT_STOPS = 0.3;

/** Max perceptual-value displacement at slider = ±100 for each tonal region. */
export const TONE_GAIN = { shadows: 0.18, highlights: 0.18, whites: 0.12, blacks: 0.12 } as const;

/** Smoothstep edges (on perceptual value v in [0,1]) defining each tonal region. */
export const TONE_EDGES = {
  shadows: [0.15, 0.65], // weight 1 below 0.15, fades to 0 by 0.65
  highlights: [0.35, 0.85], // weight 0 below 0.35, rises to 1 by 0.85
  whites: [0.7, 1.0],
  blacks: [0.0, 0.3], // weight 1 at 0, fades to 0 by 0.3
} as const;

/** Below this linear luminance the luminance-ratio scaling blends toward a neutral grey. */
export const RATIO_FLOOR = 1e-3;

// ---------------------------------------------------------------- white balance

/**
 * Per-channel linear gain for (temperature, tint). Warm (+temp) raises red and lowers blue;
 * +tint lowers green (toward magenta). Gains are normalised so that the luminance of a
 * unit-white pixel is unchanged — white balance shifts colour, not brightness.
 */
export function wbMultipliers(temperature: number, tint: number): Vec3 {
  const t = temperature / 100;
  const s = tint / 100;
  const raw: Vec3 = [Math.pow(2, TEMP_STOPS * t), Math.pow(2, -TINT_STOPS * s), Math.pow(2, -TEMP_STOPS * t)];
  const y = luminance(raw);
  return [raw[0] / y, raw[1] / y, raw[2] / y];
}

/**
 * Inverse of `wbMultipliers`: given the linear RGB of something that *should* be neutral,
 * return the (temperature, tint) that makes it neutral. Clamped to the slider range.
 * Exact inverse when the solution is within ±100.
 */
export function solveWhiteBalance(neutral: Vec3): { temperature: number; tint: number } {
  const eps = 1e-6;
  const [r, g, b] = [Math.max(neutral[0], eps), Math.max(neutral[1], eps), Math.max(neutral[2], eps)];
  // Gains needed to equalise channels are ∝ 1/neutral.
  const gr = 1 / r, gg = 1 / g, gb = 1 / b;
  const t = Math.log2(gr / gb) / (2 * TEMP_STOPS);
  const s = -Math.log2(gg / Math.sqrt(gr * gb)) / TINT_STOPS;
  return {
    temperature: clamp(t * 100, -100, 100),
    tint: clamp(s * 100, -100, 100),
  };
}

// ---------------------------------------------------------------- exposure

/** Linear-light gain for an exposure value in stops: 2^stops. */
export function exposureGain(stops: number): number {
  return Math.pow(2, stops);
}

// ---------------------------------------------------------------- tone

/**
 * Smooth weight in [0,1] for how strongly a tonal region affects perceptual value v.
 * No hard thresholds: every region is a smoothstep so adjustments blend across tones.
 */
export function toneWeight(v: number, region: keyof typeof TONE_EDGES): number {
  const [e0, e1] = TONE_EDGES[region];
  const vv = clamp(v, 0, 1);
  switch (region) {
    case 'shadows':
    case 'blacks':
      return 1 - smoothstep(e0, e1, vv);
    case 'highlights':
    case 'whites':
      return smoothstep(e0, e1, vv);
  }
}

/** Contrast slider [-100,100] -> shape parameter m of the gain curve (see contrastCurve). */
export function contrastShape(contrast: number): number {
  const c = contrast / 100;
  return c >= 0 ? c : c * 0.5;
}

/**
 * Symmetric S-curve about the mid-point (0.5) with shape m:
 *   lower half  y = 0.5 · x / (1 + m(1−x)),  x = 2v        (mirrored for the upper half)
 * m > 0 steepens the middle (slope 1+m) and flattens the ends; m < 0 does the opposite.
 * m = 0 is exactly the identity. f(0)=0, f(0.5)=0.5, f(1)=1 and it is monotonic for m > −1.
 * Values above 1 (from exposure) pass through unchanged.
 */
export function contrastCurve(v: number, m: number): number {
  if (v >= 1) return v;
  if (v <= 0) return 0;
  if (v <= 0.5) {
    const x = 2 * v;
    return (0.5 * x) / (1 + m * (1 - x));
  }
  const x = 2 - 2 * v;
  return 1 - (0.5 * x) / (1 + m * (1 - x));
}

/**
 * Tone mapping of a perceptual value v (sRGB-encoded luminance): contrast, then the four
 * regional displacements weighted by the *post-contrast* value.
 */
export function toneCurve(v: number, p: Pick<EditParams, 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>): number {
  const vc = contrastCurve(v, contrastShape(p.contrast));
  const d =
    TONE_GAIN.shadows * (p.shadows / 100) * toneWeight(vc, 'shadows') +
    TONE_GAIN.highlights * (p.highlights / 100) * toneWeight(vc, 'highlights') +
    TONE_GAIN.whites * (p.whites / 100) * toneWeight(vc, 'whites') +
    TONE_GAIN.blacks * (p.blacks / 100) * toneWeight(vc, 'blacks');
  return Math.max(vc + d, 0);
}

/**
 * Apply the tone curve to a linear RGB pixel by scaling it so its luminance lands on the
 * curve's output. Scaling (rather than curving each channel) keeps hue and avoids the
 * saturation shifts of per-channel curves. Near black the ratio is ill-conditioned, so
 * it blends to a neutral grey of the target luminance — this is what lets Blacks lift
 * pure black.
 */
export function applyTone(c: Vec3, p: EditParams): Vec3 {
  const y = luminance(c);
  const v = linearToSrgb(y);
  const v2 = toneCurve(v, p);
  const y2 = srgbToLinear(v2);
  const w = clamp(y / RATIO_FLOOR, 0, 1);
  const k = y2 / Math.max(y, 1e-6);
  return [
    y2 + (c[0] * k - y2) * w,
    y2 + (c[1] * k - y2) * w,
    y2 + (c[2] * k - y2) * w,
  ];
}

// ---------------------------------------------------------------- colour

/**
 * Saturation and vibrance, scaled about luminance in linear light.
 *   s = (1 + saturation/100) · (1 + vibrance/100 · (1 − chromaEstimate))
 * Vibrance therefore acts mostly on muted colours and leaves saturated ones alone.
 */
export function applyColor(c: Vec3, p: EditParams): Vec3 {
  const y = luminance(c);
  const mx = Math.max(c[0], c[1], c[2], 0);
  const mn = Math.max(Math.min(c[0], c[1], c[2]), 0);
  const chroma = clamp((mx - mn) / (mx + 1e-6), 0, 1);
  const s = Math.max((1 + p.saturation / 100) * (1 + (p.vibrance / 100) * (1 - chroma)), 0);
  return [y + (c[0] - y) * s, y + (c[1] - y) * s, y + (c[2] - y) * s];
}
