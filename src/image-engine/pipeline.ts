/**
 * The render pipeline as data: an ordered list of stages.
 *
 * Each stage has a CPU implementation (reference / tests / export fallback) and a GLSL
 * function (real-time preview). The order is a parameter, so later phases can reorder
 * or insert stages (curves, colour mixer, local masks, ...) without touching the renderer.
 */
import { linearToSrgb, srgbToLinear, type Vec3 } from '../color/colorSpace';
import { applyColor, applyTone, exposureGain, wbMultipliers } from './model';
import type { EditParams } from './params';

export type StageId = 'whiteBalance' | 'exposure' | 'tone' | 'color';

export interface Stage {
  id: StageId;
  cpu(c: Vec3, p: EditParams): Vec3;
}

export const STAGES: Record<StageId, Stage> = {
  whiteBalance: {
    id: 'whiteBalance',
    cpu(c, p) {
      const m = wbMultipliers(p.temperature, p.tint);
      return [c[0] * m[0], c[1] * m[1], c[2] * m[2]];
    },
  },
  exposure: {
    id: 'exposure',
    cpu(c, p) {
      const g = exposureGain(p.exposure);
      return [c[0] * g, c[1] * g, c[2] * g];
    },
  },
  tone: { id: 'tone', cpu: applyTone },
  color: { id: 'color', cpu: applyColor },
};

/** Default processing order: colour handling -> exposure -> tone -> colour adjustments. */
export const DEFAULT_PIPELINE: StageId[] = ['whiteBalance', 'exposure', 'tone', 'color'];

/** Run the pipeline on one linear-light pixel. Output is unclamped linear light. */
export function processLinear(c: Vec3, p: EditParams, order: StageId[] = DEFAULT_PIPELINE): Vec3 {
  let out = c;
  for (const id of order) out = STAGES[id].cpu(out, p);
  return out;
}

/** Full display transform for one 8-bit sRGB pixel (reference for the GPU path). */
export function renderPixel8(rgb: [number, number, number], p: EditParams, order: StageId[] = DEFAULT_PIPELINE): [number, number, number] {
  const lin: Vec3 = [srgbToLinear(rgb[0] / 255), srgbToLinear(rgb[1] / 255), srgbToLinear(rgb[2] / 255)];
  const o = processLinear(lin, p, order);
  const enc = (x: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(x))) * 255);
  return [enc(o[0]), enc(o[1]), enc(o[2])];
}

/**
 * Render a whole RGBA8 buffer on the CPU. Slow, but exact and dependency-free: it is the
 * reference the GPU output is checked against, and a fallback where WebGL2 is missing.
 */
export function renderImageData(src: Uint8ClampedArray | Uint8Array, p: EditParams, order: StageId[] = DEFAULT_PIPELINE): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const px = renderPixel8([src[i], src[i + 1], src[i + 2]], p, order);
    out[i] = px[0];
    out[i + 1] = px[1];
    out[i + 2] = px[2];
    out[i + 3] = src[i + 3];
  }
  return out;
}
