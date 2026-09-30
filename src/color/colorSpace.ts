/**
 * Colour-space helpers shared by the CPU reference renderer and the tests.
 * The GLSL versions in image-engine/glsl.ts implement the same formulas.
 *
 * Working space: linear-light RGB with sRGB/Rec.709 primaries (unbounded above 1.0
 * so exposure can push values past white and later stages can pull them back).
 */

export type Vec3 = [number, number, number];

/** Rec.709 / sRGB luminance weights for linear-light RGB. */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/** IEC 61966-2-1 sRGB decode: encoded [0,1] -> linear light. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** IEC 61966-2-1 sRGB encode: linear light -> encoded. Negative inputs clamp to 0. */
export function linearToSrgb(x: number): number {
  if (x <= 0) return 0;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function luminance(c: Vec3): number {
  return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** GLSL-compatible smoothstep (edge0 < edge1). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
