/**
 * CPU reference implementations of the Phase-2 adjustments. The GLSL in glsl.ts mirrors
 * these formulas; `npm run verify:gpu` checks the two agree. See docs/image-engine.md.
 */
import { luminance, smoothstep, clamp, linearToSrgb, srgbToLinear, type Vec3 } from '../color/colorSpace';
import { linearToOklab, oklabToLinear } from './oklab';
import { RATIO_FLOOR } from './model';
import { sampleLut } from './curves';

// ================================================================== tone curve

/**
 * Apply the composed RGB lookup table in encoded space. Linear -> sRGB-encoded -> clamp to
 * [0,1] -> LUT -> decode. (Curves are display-referred, like the histogram they are drawn on.)
 */
export function applyCurve(c: Vec3, lut: Float32Array): Vec3 {
  return [
    srgbToLinear(sampleLut(lut, 0, linearToSrgb(c[0]))),
    srgbToLinear(sampleLut(lut, 1, linearToSrgb(c[1]))),
    srgbToLinear(sampleLut(lut, 2, linearToSrgb(c[2]))),
  ];
}

// ================================================================== colour mixer

/** OKLCH hue (degrees) of the eight bands: red, orange, yellow, green, aqua, blue, purple, magenta. */
export const MIX_HUES = [29.2, 53.0, 109.8, 142.5, 194.8, 264.1, 293.9, 328.4];
export const MIX_HUE_SHIFT_DEG = 30; // hue slider ±100 -> ±30°
export const MIX_LUM_GAIN = 0.25; // luminance slider ±100 -> ±0.25 OKLab L
export const MIX_CHROMA_GATE = 0.03; // below this chroma hue is ill-defined; effect fades out

/**
 * Smooth partition-of-unity weights over the eight bands for hue h (degrees): only the two
 * neighbouring bands are non-zero, cross-fading with a smoothstep, so weights always sum to 1
 * and there is no hard boundary between colours.
 */
export function mixWeights(hDeg: number): { a: number; b: number; wa: number; wb: number } {
  let h = ((hDeg % 360) + 360) % 360;
  if (h < MIX_HUES[0]) h += 360;
  let a = 7;
  for (let i = 0; i < 7; i++) if (h >= MIX_HUES[i] && h < MIX_HUES[i + 1]) { a = i; break; }
  const b = (a + 1) % 8;
  const ha = MIX_HUES[a], hb = b === 0 ? MIX_HUES[0] + 360 : MIX_HUES[b];
  const t = smoothstep(0, 1, (h - ha) / (hb - ha));
  return { a, b, wa: 1 - t, wb: t };
}

export interface MixerTables { hue: number[]; sat: number[]; lum: number[] } // each 8 values, slider/100

export function applyMixer(c: Vec3, m: MixerTables): Vec3 {
  const lab = linearToOklab([Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)]);
  const C = Math.hypot(lab[1], lab[2]);
  if (C < 1e-6) return [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)]; // neutral: hue undefined
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  const { a, b, wa, wb } = mixWeights(h);
  const k = smoothstep(0, MIX_CHROMA_GATE, C);
  const dh = (wa * m.hue[a] + wb * m.hue[b]) * MIX_HUE_SHIFT_DEG * k;
  const ds = (wa * m.sat[a] + wb * m.sat[b]) * k;
  const dl = (wa * m.lum[a] + wb * m.lum[b]) * MIX_LUM_GAIN * k;
  const C2 = Math.max(C * (1 + ds), 0);
  const h2 = ((h + dh) * Math.PI) / 180;
  const out = oklabToLinear([lab[0] + dl, C2 * Math.cos(h2), C2 * Math.sin(h2)]);
  return [Math.max(out[0], 0), Math.max(out[1], 0), Math.max(out[2], 0)];
}

// ================================================================== colour grading

export const GRADE_CHROMA = 0.08; // OKLab chroma added at saturation = 100
export const GRADE_LUM_GAIN = 0.2; // luminance slider ±100 -> ±0.2 OKLab L

export interface GradeTables {
  /** Per range [shadows, mid, highlights, global]: tint vector (a,b) in OKLab and L offset. */
  a: number[]; b: number[]; l: number[];
  shift: number; // balance: crossover shift
  width: number; // blending: half-width of the transitions
}

export function gradeWeights(v: number, shift: number, width: number): [number, number, number] {
  const ws = 1 - smoothstep(0.3 + shift - width, 0.3 + shift + width, v);
  const wh = smoothstep(0.7 + shift - width, 0.7 + shift + width, v);
  return [ws, clamp(1 - ws - wh, 0, 1), wh];
}

export function applyGrading(c: Vec3, g: GradeTables): Vec3 {
  const cc: Vec3 = [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)];
  const lab = linearToOklab(cc);
  const [ws, wm, wh] = gradeWeights(linearToSrgb(luminance(cc)), g.shift, g.width);
  const w = [ws, wm, wh, 1];
  let L = lab[0], A = lab[1], B = lab[2];
  for (let i = 0; i < 4; i++) { L += w[i] * g.l[i]; A += w[i] * g.a[i]; B += w[i] * g.b[i]; }
  const out = oklabToLinear([L, A, B]);
  return [Math.max(out[0], 0), Math.max(out[1], 0), Math.max(out[2], 0)];
}

// ================================================================== vignette

export const VIGNETTE_STOPS = 2.5; // max exposure change (stops) at |amount| = 100 in full effect

export interface VignetteTables {
  amount: number; // [-1,1]
  start: number; // radius where the effect begins (midpoint)
  width: number; // transition width (feather)
  roundness: number; // [-1,1]
  highlights: number; // [0,1]
  aspect: number; // width / height
}

/** Normalised distance from centre: 0 at centre, 1 at the frame corners (for roundness ≤ 0). */
export function vignetteDistance(u: number, v: number, t: VignetteTables): number {
  let x = (u - 0.5) * 2, y = (v - 0.5) * 2;
  const r = t.roundness;
  if (r > 0) { // bend the shape towards a true circle in image space
    if (t.aspect >= 1) y *= 1 + (1 / t.aspect - 1) * r;
    else x *= 1 + (t.aspect - 1) * r;
  }
  const n = 2 + 4 * Math.max(-r, 0); // 2 = ellipse, up to 6 = rounded rectangle
  return Math.pow((Math.pow(Math.abs(x), n) + Math.pow(Math.abs(y), n)) / 2, 1 / n);
}

/** (u, v) are normalised image coordinates, v counted from the top. */
export function applyVignette(c: Vec3, t: VignetteTables, u: number, v: number): Vec3 {
  const d = vignetteDistance(u, v, t);
  const k = smoothstep(t.start, t.start + t.width, d);
  let gain = Math.pow(2, t.amount * k * VIGNETTE_STOPS);
  if (t.amount < 0 && t.highlights > 0) {
    const wh = smoothstep(0.4, 0.9, linearToSrgb(luminance(c)));
    gain = gain + (1 - gain) * t.highlights * wh;
  }
  return [c[0] * gain, c[1] * gain, c[2] * gain];
}

// ================================================================== grain

export const GRAIN_STD = 0.12; // noise σ in encoded units at amount = 100

export interface GrainTables { amp: number; cell: number; rough: number }

/** 32-bit integer hash -> [0,1). Identical (bit-for-bit) to the GLSL `hash2`. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 1597334677) ^ Math.imul(y >>> 0, 3812015801)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}

const hn = (x: number, y: number) => (hash2(x, y) - 0.5) * 2; // uniform [-1,1], σ ≈ 0.577

/**
 * Procedural grain, zero-mean, unit-ish σ (≈0.577, like uniform white noise).
 *  - "soft" part: bilinearly interpolated lattice noise whose cell size is the Size slider
 *    (×1.5 restores the σ lost by interpolation)
 *  - "fine" part: independent per-pixel noise
 * Roughness cross-fades soft -> fine. (x, y) are pixel coords (y from bottom).
 */
export function grainNoise(x: number, y: number, cell: number, rough: number): number {
  const px = (x + 0.5) / cell, py = (y + 0.5) / cell;
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const n00 = hn(ix, iy), n10 = hn(ix + 1, iy), n01 = hn(ix, iy + 1), n11 = hn(ix + 1, iy + 1);
  const soft = 1.5 * ((n00 * (1 - fx) + n10 * fx) * (1 - fy) + (n01 * (1 - fx) + n11 * fx) * fy);
  const fine = hn(Math.floor(x), Math.floor(y));
  return soft + (fine - soft) * rough;
}

/** Grain lives in encoded space and is strongest in the mid-tones (like film). */
export function applyGrain(c: Vec3, t: GrainTables, x: number, y: number): Vec3 {
  const n = grainNoise(x, y, t.cell, t.rough);
  const v = linearToSrgb(luminance(c));
  const vc = clamp(v, 0, 1);
  const weight = 0.25 + 0.75 * 4 * vc * (1 - vc);
  const d = n * t.amp * weight;
  return [
    srgbToLinear(Math.max(linearToSrgb(c[0]) + d, 0)),
    srgbToLinear(Math.max(linearToSrgb(c[1]) + d, 0)),
    srgbToLinear(Math.max(linearToSrgb(c[2]) + d, 0)),
  ];
}

// ================================================================== local contrast (texture / clarity / dehaze)

export const TEXTURE_GAIN = 0.9;
export const CLARITY_GAIN = 0.8;
export const CLARITY_SOFTNESS = 3; // detail d -> d / (1 + 3|d|): tames halos at strong edges
export const DEHAZE_AIRLIGHT = 1.0; // assumed atmospheric light (linear)
export const DEHAZE_OMEGA = 0.9; // how much of the haze estimate is removed at +100
export const DEHAZE_MIN_T = 0.15; // transmission floor
export const HAZE_ADD_LEVEL = 0.7; // colour blended in for negative dehaze
export const HAZE_ADD_MAX = 0.6;

export interface LocalTables { texture: number; clarity: number; dehaze: number } // slider/100
export interface LocalBlurs { v0: number; v1: number; dark: number } // blurred v @σ_texture, v @σ_clarity, dark channel @σ_dehaze

/** Scale a pixel so its luminance becomes y2 (hue-preserving; blends to grey near black). */
export function scaleToLuma(c: Vec3, y: number, y2: number): Vec3 {
  const w = clamp(y / RATIO_FLOOR, 0, 1);
  const k = y2 / Math.max(y, 1e-6);
  return [y2 + (c[0] * k - y2) * w, y2 + (c[1] * k - y2) * w, y2 + (c[2] * k - y2) * w];
}

export function applyLocal(c: Vec3, t: LocalTables, b: LocalBlurs): Vec3 {
  const y0 = luminance(c);
  const v0 = linearToSrgb(y0);
  let out: Vec3 = c;
  // Dehaze: simplified dark-channel-prior model, J = (I − A)/t + A with t from the local dark channel.
  if (t.dehaze > 0) {
    const tr = Math.max(1 - DEHAZE_OMEGA * t.dehaze * (b.dark / DEHAZE_AIRLIGHT), DEHAZE_MIN_T);
    out = [
      Math.max((c[0] - DEHAZE_AIRLIGHT) / tr + DEHAZE_AIRLIGHT, 0),
      Math.max((c[1] - DEHAZE_AIRLIGHT) / tr + DEHAZE_AIRLIGHT, 0),
      Math.max((c[2] - DEHAZE_AIRLIGHT) / tr + DEHAZE_AIRLIGHT, 0),
    ];
  } else if (t.dehaze < 0) {
    const k = -t.dehaze * HAZE_ADD_MAX;
    out = [c[0] + (HAZE_ADD_LEVEL - c[0]) * k, c[1] + (HAZE_ADD_LEVEL - c[1]) * k, c[2] + (HAZE_ADD_LEVEL - c[2]) * k];
  }
  const y1 = luminance(out);
  let v = linearToSrgb(y1);
  // Texture (fine scale, all tones) and clarity (broad scale, mid-tones): add scaled detail = v − blur(v).
  const dt = v0 - b.v0;
  const dc = v0 - b.v1;
  const mid = 4 * clamp(v0, 0, 1) * (1 - clamp(v0, 0, 1));
  v += TEXTURE_GAIN * t.texture * dt + CLARITY_GAIN * t.clarity * mid * (dc / (1 + CLARITY_SOFTNESS * Math.abs(dc)));
  v = Math.max(v, 0);
  return scaleToLuma(out, y1, srgbToLinear(v));
}
