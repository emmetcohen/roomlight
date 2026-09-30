/**
 * The render pipeline as data: an ordered list of stages, preceded by the SOURCE SAMPLER.
 *
 * Every stage has a CPU implementation (this file + model.ts/adjustments.ts/masks: the
 * reference, used by tests and as a fallback) and a GLSL implementation (glsl.ts: real-time).
 * The order is a parameter, so later phases can reorder or insert stages.
 *
 *   original pixels ─► source sampler (crop · rotate · perspective · lens distortion · CA)
 *                   ─► stages: lens vignette, WB, exposure, tone, [local], curve, mixer,
 *                              grading, colour, local-adjustment masks, vignette, grain
 *                   ─► encode
 *
 * Stage kinds: per-pixel stages read only the pixel (plus its coordinates/mask values); the
 * `local` stage (texture/clarity/dehaze) also reads blurred neighbourhoods, so the renderer
 * splits the pipeline there: [stages before] → blur → [local + stages after].
 */
import { linearToSrgb, luminance, srgbToLinear, type Vec3 } from '../color/colorSpace';
import { outputSize, outputToSource, toMaskSpace } from '../geometry/transform';
import { LENS_VIGNETTE_STOPS } from '../lens/profiles';
import { applyMaskAdjust, maskValue } from '../masks/evaluate';
import {
  applyCurve, applyGrain, applyGrading, applyLocal, applyMixer, applyVignette, type LocalBlurs, type LocalTables,
} from './adjustments';
import { blurField, sampleBlur } from './blur';
import { derive, type Derived, type StageId } from './derive';
import { applyColor, applyTone } from './model';
import type { EditParams } from './params';

export type { StageId } from './derive';

/** Default processing order. */
export const DEFAULT_PIPELINE: StageId[] = [
  'lens', 'whiteBalance', 'exposure', 'tone', 'local', 'curve', 'mixer', 'grading', 'color', 'masks', 'vignette', 'grain',
];

/** Per-pixel context: output pixel (x, y from the BOTTOM) plus what the source sampler found. */
export interface PixelCtx {
  x: number; y: number;
  mx: number; my: number; // mask-space position of this pixel
  rc2: number; // squared radius from the optical centre, / half-diagonal² (lens stages)
  c0: Vec3; // the ORIGINAL colour here (linear) — range masks look at this
}

const LUT8 = new Float64Array(256).map((_, i) => srgbToLinear(i / 255));

/** Bilinear sample of the source at (u, v) in 0..1 (y down), in linear light, clamp-to-edge. */
function bilinear(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, u: number, v: number): Vec3 {
  const fx = u * sw - 0.5, fy = v * sh - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x: number, y: number): Vec3 => {
    const o = (Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))) * 4;
    return [LUT8[src[o]], LUT8[src[o + 1]], LUT8[src[o + 2]]];
  };
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = (a[i] * (1 - tx) + b[i] * tx) * (1 - ty) + (c[i] * (1 - tx) + e[i] * tx) * ty;
  return out;
}

/**
 * The source sampler: which original pixels does output pixel (x, y) read?
 * Output uv → (crop, inverse geometry matrix) → source position → lens distortion / CA → read.
 * `alpha` is 0 where the transform reads outside the original (rotated corners etc.).
 */
export function sampleSource(src: Uint8Array | Uint8ClampedArray, d: Derived, x: number, y: number): PixelCtx & { c: Vec3; alpha: number } {
  const { w, h } = d, sw = d.src.w, sh = d.src.h;
  if (!d.remap && w === sw && h === sh) { // exact texel copy: the identity fast path
    const o = ((h - 1 - y) * w + x) * 4;
    const c: Vec3 = [LUT8[src[o]], LUT8[src[o + 1]], LUT8[src[o + 2]]];
    const px = (x + 0.5 - w / 2) / d.geo.L, py = (h / 2 - y - 0.5) / d.geo.L;
    return { x, y, mx: px, my: py, rc2: ((x + 0.5 - w / 2) ** 2 + (h / 2 - y - 0.5) ** 2) / (d.lens.R * d.lens.R), c0: c, c, alpha: src[o + 3] / 255 };
  }
  const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
  const p = outputToSource(d.geo, u, v);
  if (!p) return { x, y, mx: 0, my: 0, rc2: 0, c0: [0, 0, 0], c: [0, 0, 0], alpha: 0 };
  const [mx, my] = toMaskSpace(d.geo, p[0], p[1]);
  const rc2 = (p[0] * p[0] + p[1] * p[1]) / (d.lens.R * d.lens.R);
  const k = 1 - d.lens.a * rc2;
  const px = p[0] * k, py = p[1] * k;
  const uG = px / sw + 0.5, vG = py / sh + 0.5;
  const valid = uG >= 0 && uG <= 1 && vG >= 0 && vG <= 1;
  if (!valid) return { x, y, mx, my, rc2, c0: [0, 0, 0], c: [0, 0, 0], alpha: 0 };
  let c = bilinear(src, sw, sh, uG, vG);
  if (d.lens.ca !== 0) {
    const r = bilinear(src, sw, sh, (px * (1 + d.lens.ca)) / sw + 0.5, (py * (1 + d.lens.ca)) / sh + 0.5);
    const b = bilinear(src, sw, sh, (px * (1 - d.lens.ca)) / sw + 0.5, (py * (1 - d.lens.ca)) / sh + 0.5);
    c = [r[0], c[1], b[2]];
  }
  const ai = (Math.min(sh - 1, Math.max(0, Math.round(vG * sh - 0.5))) * sw + Math.min(sw - 1, Math.max(0, Math.round(uG * sw - 0.5)))) * 4 + 3;
  return { x, y, mx, my, rc2, c0: c, c, alpha: src[ai] / 255 };
}

/** Local amounts for this pixel: global sliders plus every mask's texture/clarity/dehaze × its mask value. */
function localAt(d: Derived, ctx: PixelCtx): LocalTables {
  const t = { ...d.local };
  const m = d.masks;
  for (let i = 0; i < m.count; i++) {
    if (!m.a3[i][2]) continue;
    const v = maskValue(m, i, ctx.mx, ctx.my, ctx.c0);
    t.texture += v * m.a2[i][2]; t.clarity += v * m.a2[i][3]; t.dehaze += v * m.a3[i][0];
  }
  const cl = (x: number) => Math.min(1, Math.max(-1, x));
  return { texture: cl(t.texture), clarity: cl(t.clarity), dehaze: cl(t.dehaze) };
}

export function runStage(id: StageId, c: Vec3, d: Derived, ctx: PixelCtx, blurs: LocalBlurs): Vec3 {
  switch (id) {
    case 'lens': { const g = Math.pow(2, d.lens.vig * LENS_VIGNETTE_STOPS * ctx.rc2); return [c[0] * g, c[1] * g, c[2] * g]; }
    case 'whiteBalance': return [c[0] * d.wb[0], c[1] * d.wb[1], c[2] * d.wb[2]];
    case 'exposure': return [c[0] * d.expGain, c[1] * d.expGain, c[2] * d.expGain];
    case 'tone': return applyTone(c, d.p);
    case 'local': return applyLocal(c, localAt(d, ctx), blurs);
    case 'curve': return applyCurve(c, d.lut);
    case 'mixer': return applyMixer(c, d.mixer);
    case 'grading': return applyGrading(c, d.grade);
    case 'color': return applyColor(c, d.p);
    case 'masks': {
      let out = c;
      for (let i = 0; i < d.masks.count; i++) {
        const m = maskValue(d.masks, i, ctx.mx, ctx.my, ctx.c0);
        if (m > 0) out = applyMaskAdjust(d.masks, i, out, m);
      }
      return out;
    }
    case 'vignette': return applyVignette(c, d.vignette, (ctx.x + 0.5) / d.w, 1 - (ctx.y + 0.5) / d.h);
    case 'grain': return applyGrain(c, d.grain, ctx.x, ctx.y);
  }
}

const encode8 = (x: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(x))) * 255);

export interface RenderedImage { data: Uint8ClampedArray; width: number; height: number }

/**
 * Render on the CPU (row 0 = top). Slow but exact: the reference the GPU output is checked
 * against, and the path tests use. Output size defaults to the cropped size at source resolution.
 */
export function renderImage(
  src: Uint8ClampedArray | Uint8Array, sw: number, sh: number, p: EditParams,
  order: StageId[] = DEFAULT_PIPELINE, size?: { w: number; h: number },
): RenderedImage {
  const { w, h } = size ?? outputSize(p, sw, sh);
  const d = derive(p, w, h, { w: sw, h: sh });
  const active = order.filter((id) => d.active[id]);
  const li = active.indexOf('local');
  const seg1 = li < 0 ? active : active.slice(0, li);
  const seg2 = li < 0 ? [] : active.slice(li);

  // Linear-light float buffer in GL orientation (y = 0 is the bottom row).
  const buf = new Float32Array(w * h * 3);
  const blurs: LocalBlurs = { v0: 0, v1: 0, dark: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = sampleSource(src, d, x, y);
    let c = s.c;
    for (const id of seg1) c = runStage(id, c, d, s, blurs);
    const o = (y * w + x) * 3;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
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
      const s = sampleSource(src, d, x, y);
      let c: Vec3 = [buf[o], buf[o + 1], buf[o + 2]];
      if (fields) {
        blurs.v0 = sampleBlur(fields[0], d.blur[0], x, y);
        blurs.v1 = sampleBlur(fields[1], d.blur[1], x, y);
        blurs.dark = sampleBlur(fields[2], d.blur[2], x, y);
      }
      for (const id of seg2) c = runStage(id, c, d, s, blurs);
      const t = (dy * w + x) * 4;
      if (s.alpha === 0) continue; // outside the original: transparent
      out[t] = encode8(c[0]); out[t + 1] = encode8(c[1]); out[t + 2] = encode8(c[2]);
      out[t + 3] = Math.round(s.alpha * 255);
    }
  }
  return { data: out, width: w, height: h };
}

/** Same-size render (output = source size) returning just the pixels. Convenience for tests. */
export function renderImageData(src: Uint8ClampedArray | Uint8Array, w: number, h: number, p: EditParams, order: StageId[] = DEFAULT_PIPELINE): Uint8ClampedArray {
  return renderImage(src, w, h, p, order).data;
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
  const ctx: PixelCtx = { x: 0, y: 0, mx: 0, my: 0, rc2: 0, c0: c };
  let out = c;
  for (const id of order) if (d.active[id]) out = runStage(id, out, d, ctx, self);
  return out;
}
