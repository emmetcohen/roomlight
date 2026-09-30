/**
 * CPU reference for mask evaluation and local adjustments (mirrored by the GLSL in glsl.ts).
 *
 * Flow per pixel:  m_i = maskValue(mask i, position, ORIGINAL colour)  →  each mask's adjustments,
 * with every amount scaled by m_i, are applied in order: white balance, exposure, tone, colour.
 * Scaling the *amounts* (rather than blending results) makes "a 50 % mask gives half the
 * adjustment" literally true for exposure (half the stops) and approximately true elsewhere.
 *
 * Range masks (colour / luminance) look at the original picture — the pixel after geometry and
 * lens sampling but before any edit — so moving a slider inside a mask never moves the mask.
 */
import { linearToSrgb, luminance, smoothstep, type Vec3 } from '../color/colorSpace';
import { applyColorSV, applyToneT, wbMultipliersN } from '../image-engine/model';
import { linearToOklab } from '../image-engine/oklab';
import { contrastShape } from '../image-engine/model';
import { EMPTY_RASTER, rasterize, sampleRaster } from './brush';
import { getSegmentRaster } from './segmentation';
import { MAX_COMPONENTS, MAX_MASKS, MAX_RASTERS, type Mask, type LocalAdjust } from './types';

export const C_LINEAR = 0, C_RADIAL = 1, C_BRUSH = 2, C_COLOR = 3, C_LUM = 4;
export const OP_ADD = 0, OP_SUBTRACT = 1, OP_INTERSECT = 2;
export const COLOR_L_WEIGHT = 0.5; // lightness counts half as much as hue/chroma in colour-range distance
export const COLOR_RADIUS_MIN = 0.02, COLOR_RADIUS_SPAN = 0.3;
export const LUM_SMOOTH_SCALE = 0.25;

export interface FlatComponent { type: number; op: number; inv: number; p0: number[]; p1: number[] }

export interface MaskTables {
  count: number;
  start: number[]; n: number[]; inv: number[]; amt: number[];
  a0: number[][]; a1: number[][]; a2: number[][]; a3: number[][]; // per-mask local adjustments (see packAdjust)
  comps: FlatComponent[];
  rasters: Uint8Array[]; // one per raster layer slot
  /** Index into the ORIGINAL `masks` array for each flat mask (for the UI overlay). */
  source: number[];
}

export const emptyTables = (): MaskTables => ({ count: 0, start: [], n: [], inv: [], amt: [], a0: [], a1: [], a2: [], a3: [], comps: [], rasters: [], source: [] });

/** [exposure(stops), contrast, highlights, shadows], [whites, blacks, temp, tint], [sat, vib, texture, clarity], [dehaze, hasBasic, hasLocal, 0] (sliders /100). */
export function packAdjust(a: LocalAdjust): [number[], number[], number[], number[]] {
  const v = (k: keyof LocalAdjust) => (a[k] ?? 0);
  const a0 = [v('exposure'), v('contrast') / 100, v('highlights') / 100, v('shadows') / 100];
  const a1 = [v('whites') / 100, v('blacks') / 100, v('temperature') / 100, v('tint') / 100];
  const a2 = [v('saturation') / 100, v('vibrance') / 100, v('texture') / 100, v('clarity') / 100];
  const hasBasic = [...a0, ...a1, a2[0], a2[1]].some((x) => x !== 0) ? 1 : 0;
  const hasLocal = a2[2] !== 0 || a2[3] !== 0 || v('dehaze') !== 0 ? 1 : 0;
  return [a0, a1, a2, [v('dehaze') / 100, hasBasic, hasLocal, 0]];
}

export function flattenMasks(masks: Mask[]): MaskTables {
  const t = emptyTables();
  masks.forEach((m, mi) => {
    if (!m.enabled || m.components.length === 0 || t.count >= MAX_MASKS) return;
    if (t.comps.length + m.components.length > MAX_COMPONENTS) return;
    const start = t.comps.length;
    let ok = true;
    const pending: FlatComponent[] = [];
    const rasterStart = t.rasters.length;
    for (const c of m.components) {
      const s = c.shape;
      const op = c.op === 'subtract' ? OP_SUBTRACT : c.op === 'intersect' ? OP_INTERSECT : OP_ADD;
      const inv = c.invert ? 1 : 0;
      switch (s.type) {
        case 'linear': pending.push({ type: C_LINEAR, op, inv, p0: [s.x1, s.y1, s.x2, s.y2], p1: [s.feather / 100, 0, 0, 0] }); break;
        case 'radial': pending.push({ type: C_RADIAL, op, inv, p0: [s.cx, s.cy, s.rx, s.ry], p1: [(s.rotation * Math.PI) / 180, s.feather / 100, 0, 0] }); break;
        case 'brush': case 'segment': {
          if (t.rasters.length >= MAX_RASTERS) { ok = false; break; }
          const data = s.type === 'brush' ? rasterize(s.strokes) : getSegmentRaster(c.id) ?? EMPTY_RASTER;
          pending.push({ type: C_BRUSH, op, inv, p0: [t.rasters.length, 0, 0, 0], p1: [0, 0, 0, 0] });
          t.rasters.push(data);
          break;
        }
        case 'color': pending.push({ type: C_COLOR, op, inv, p0: [s.L, s.a, s.b, COLOR_RADIUS_MIN + (s.range / 100) * COLOR_RADIUS_SPAN], p1: [0, 0, 0, 0] }); break;
        case 'luminance': pending.push({ type: C_LUM, op, inv, p0: [s.min / 100, s.max / 100, (s.smooth / 100) * LUM_SMOOTH_SCALE, 0], p1: [0, 0, 0, 0] }); break;
      }
      if (!ok) break;
    }
    if (!ok) { t.rasters.length = rasterStart; return; }
    const [a0, a1, a2, a3] = packAdjust(m.adjust);
    t.start.push(start); t.n.push(pending.length); t.inv.push(m.invert ? 1 : 0); t.amt.push(m.amount / 100);
    t.a0.push(a0); t.a1.push(a1); t.a2.push(a2); t.a3.push(a3);
    t.comps.push(...pending);
    t.source.push(mi);
    t.count++;
  });
  return t;
}

/** One component's value in [0,1] at mask-space (mx, my) for original colour c0. */
export function componentValue(t: MaskTables, ci: number, mx: number, my: number, c0: Vec3): number {
  const c = t.comps[ci];
  let v = 0;
  switch (c.type) {
    case C_LINEAR: {
      const [x1, y1, x2, y2] = c.p0;
      const abx = x2 - x1, aby = y2 - y1;
      const tt = ((mx - x1) * abx + (my - y1) * aby) / Math.max(abx * abx + aby * aby, 1e-12);
      const f = Math.max(c.p1[0], 0.002);
      v = 1 - smoothstep(0.5 - 0.5 * f, 0.5 + 0.5 * f, tt);
      break;
    }
    case C_RADIAL: {
      const [cx, cy, rx, ry] = c.p0;
      const cs = Math.cos(c.p1[0]), sn = Math.sin(c.p1[0]);
      const dx = mx - cx, dy = my - cy;
      const px = (cs * dx + sn * dy) / rx, py = (-sn * dx + cs * dy) / ry; // rotate by −rotation
      const d = Math.hypot(px, py);
      const f = Math.max(c.p1[1], 0.005);
      v = 1 - smoothstep(1 - f, 1, d);
      break;
    }
    case C_BRUSH: v = sampleRaster(t.rasters[c.p0[0]], mx, my); break;
    case C_COLOR: {
      const lab = linearToOklab([Math.max(c0[0], 0), Math.max(c0[1], 0), Math.max(c0[2], 0)]);
      const dl = (lab[0] - c.p0[0]) * COLOR_L_WEIGHT, da = lab[1] - c.p0[1], db = lab[2] - c.p0[2];
      const d = Math.sqrt(dl * dl + da * da + db * db);
      const r = c.p0[3];
      v = 1 - smoothstep(0.35 * r, r, d);
      break;
    }
    case C_LUM: {
      const [lo, hi, sm] = c.p0;
      const y = linearToSrgb(luminance(c0));
      const a = lo <= 0 ? 1 : smoothstep(lo - sm, lo + sm, y);
      const b = hi >= 1 ? 1 : 1 - smoothstep(hi - sm, hi + sm, y);
      v = a * b;
      break;
    }
  }
  return c.inv ? 1 - v : v;
}

/** Final mask value of flat mask i (components combined, inverted, scaled by amount). */
export function maskValue(t: MaskTables, i: number, mx: number, my: number, c0: Vec3): number {
  const s = t.start[i], n = t.n[i];
  let m = t.comps[s].op === OP_ADD ? 0 : 1;
  for (let k = 0; k < n; k++) {
    const c = componentValue(t, s + k, mx, my, c0);
    const op = t.comps[s + k].op;
    m = op === OP_ADD ? Math.max(m, c) : op === OP_SUBTRACT ? Math.min(m, 1 - c) : Math.min(m, c);
  }
  if (t.inv[i]) m = 1 - m;
  return m * t.amt[i];
}

/** Apply mask i's basic adjustments to c with every amount scaled by m. */
export function applyMaskAdjust(t: MaskTables, i: number, c: Vec3, m: number): Vec3 {
  if (!t.a3[i][1]) return c;
  const a0 = t.a0[i], a1 = t.a1[i], a2 = t.a2[i];
  const w = wbMultipliersN(a1[2] * m, a1[3] * m);
  let o: Vec3 = [c[0] * w[0], c[1] * w[1], c[2] * w[2]];
  const g = Math.pow(2, a0[0] * m);
  o = [o[0] * g, o[1] * g, o[2] * g];
  o = applyToneT(o, contrastShape(a0[1] * m * 100), [a0[3] * m, a0[2] * m, a1[0] * m, a1[1] * m]);
  return applyColorSV(o, a2[0] * m, a2[1] * m);
}
