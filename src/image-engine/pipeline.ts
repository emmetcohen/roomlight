/**
 * The render pipeline as data: an ordered list of stages.
 *
 * Every stage has a CPU implementation (this file + model.ts/adjustments.ts: the reference,
 * used by tests and as a fallback) and a GLSL implementation (glsl.ts: real-time). The order
 * is a parameter, so later phases can reorder or insert stages without touching the renderer.
 *
 * Stage kinds:
 *  - per-pixel stages read only the pixel itself (plus its coordinates)
 *  - the `local` stage (texture/clarity/dehaze) also reads blurred neighbourhood fields, so the
 *    renderer splits the pipeline there: [stages before] -> blur -> [local + stages after].
 */
import { linearToSrgb, luminance, srgbToLinear, type Vec3 } from '../color/colorSpace';
import {
  applyCurve, applyGrain, applyGrading, applyLocal, applyMixer, applyVignette, type LocalBlurs,
} from './adjustments';
import { blurField, sampleBlur } from './blur';
import { derive, type Derived, type StageId } from './derive';
import { applyColor, applyTone } from './model';
import type { EditParams } from './params';

export type { StageId } from './derive';

/** Default processing order. */
export const DEFAULT_PIPELINE: StageId[] = [
  'whiteBalance', 'exposure', 'tone', 'local', 'curve', 'mixer', 'grading', 'color', 'vignette', 'grain',
];

/** Pixel position context: x, y in output pixels with y counted from the BOTTOM (GL convention). */
export interface PixelCtx { x: number; y: number }

export function runStage(id: StageId, c: Vec3, d: Derived, ctx: PixelCtx, blurs: LocalBlurs): Vec3 {
  switch (id) {
    case 'whiteBalance': return [c[0] * d.wb[0], c[1] * d.wb[1], c[2] * d.wb[2]];
    case 'exposure': return [c[0] * d.expGain, c[1] * d.expGain, c[2] * d.expGain];
    case 'tone': return applyTone(c, d.p);
    case 'local': return applyLocal(c, d.local, blurs);
    case 'curve': return applyCurve(c, d.lut);
    case 'mixer': return applyMixer(c, d.mixer);
    case 'grading': return applyGrading(c, d.grade);
    case 'color': return applyColor(c, d.p);
    case 'vignette': return applyVignette(c, d.vignette, (ctx.x + 0.5) / d.w, 1 - (ctx.y + 0.5) / d.h);
    case 'grain': return applyGrain(c, d.grain, ctx.x, ctx.y);
  }
}

const encode8 = (x: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(x))) * 255);
const LUT8 = new Float64Array(256).map((_, i) => srgbToLinear(i / 255));

/**
 * Render a whole RGBA8 buffer (row 0 = top) on the CPU. Slow but exact: it is the reference
 * the GPU output is checked against, and the path tests use.
 */
export function renderImageData(src: Uint8ClampedArray | Uint8Array, w: number, h: number, p: EditParams, order: StageId[] = DEFAULT_PIPELINE): Uint8ClampedArray {
  const d = derive(p, w, h);
  const active = order.filter((id) => d.active[id]);
  const li = active.indexOf('local');
  const seg1 = li < 0 ? active : active.slice(0, li);
  const seg2 = li < 0 ? [] : active.slice(li);

  // Linear-light float buffer in GL orientation (y = 0 is the bottom row).
  const buf = new Float32Array(w * h * 3);
  const blurs: LocalBlurs = { v0: 0, v1: 0, dark: 0 };
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * 4;
      let c: Vec3 = [LUT8[src[s]], LUT8[src[s + 1]], LUT8[src[s + 2]]];
      for (const id of seg1) c = runStage(id, c, d, { x, y }, blurs);
      const o = (y * w + x) * 3;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }

  let fields: Float32Array[] | null = null;
  if (seg2.length) {
    const qv = new Float32Array(w * h), qd = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const c: Vec3 = [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]];
      qv[i] = linearToSrgb(luminance(c));
      qd[i] = Math.max(Math.min(c[0], c[1], c[2]), 0);
    }
    fields = [blurField(qv, w, h, d.blur[0]), blurField(qv, w, h, d.blur[1]), blurField(qd, w, h, d.blur[2])];
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      let c: Vec3 = [buf[o], buf[o + 1], buf[o + 2]];
      if (fields) {
        blurs.v0 = sampleBlur(fields[0], d.blur[0], x, y);
        blurs.v1 = sampleBlur(fields[1], d.blur[1], x, y);
        blurs.dark = sampleBlur(fields[2], d.blur[2], x, y);
      }
      for (const id of seg2) c = runStage(id, c, d, { x, y }, blurs);
      const t = (dy * w + x) * 4;
      out[t] = encode8(c[0]); out[t + 1] = encode8(c[1]); out[t + 2] = encode8(c[2]);
      out[t + 3] = src[t + 3];
    }
  }
  return out;
}

/** One pixel through the full display transform. Neighbourhood stages see the pixel alone (no detail). */
export function renderPixel8(rgb: [number, number, number], p: EditParams, order: StageId[] = DEFAULT_PIPELINE): [number, number, number] {
  const o = renderImageData(new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]), 1, 1, p, order);
  return [o[0], o[1], o[2]];
}

/** Per-pixel stages only, on linear float input (no neighbourhood, unclamped output). For tests/analysis. */
export function processLinear(c: Vec3, p: EditParams, order: StageId[] = DEFAULT_PIPELINE): Vec3 {
  const d = derive(p, 1, 1);
  const y = linearToSrgb(luminance(c));
  const self: LocalBlurs = { v0: y, v1: y, dark: Math.max(Math.min(c[0], c[1], c[2]), 0) };
  let out = c;
  for (const id of order) if (d.active[id]) out = runStage(id, out, d, { x: 0, y: 0 }, self);
  return out;
}
