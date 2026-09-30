/**
 * Everything the renderers need that is *derived* from EditParams and the output size:
 * gains, lookup tables, blur plan, per-stage "is this stage doing anything" flags.
 * Both the CPU reference and the GPU uniform upload read from this one structure, so the two
 * cannot drift apart in how they interpret a slider.
 */
import { curvesAreIdentity, buildLut, LUT_SIZE } from './curves';
import type { GradeTables, GrainTables, LocalTables, MixerTables, VignetteTables } from './adjustments';
import { GRADE_CHROMA, GRADE_LUM_GAIN } from './adjustments';
import { contrastShape, exposureGain, wbMultipliers } from './model';
import { GRADE_RANGES, MIX_COLORS, type EditParams } from './params';
import type { Vec3 } from '../color/colorSpace';

export type StageId = 'whiteBalance' | 'exposure' | 'tone' | 'local' | 'curve' | 'mixer' | 'grading' | 'color' | 'vignette' | 'grain';

export interface BlurSpec {
  sigma: number; // in output pixels
  factor: number; // power-of-two downsample before blurring
  sigmaLow: number; // sigma / factor
  lw: number; // low-res width
  lh: number;
}

/** Blur radii are fractions of the long edge, so a preview and a full-size export look alike. */
export function blurPlan(w: number, h: number): [BlurSpec, BlurSpec, BlurSpec] {
  const L = Math.max(w, h);
  const mk = (sigma: number): BlurSpec => {
    const factor = Math.pow(2, Math.max(0, Math.ceil(Math.log2(sigma / 6))));
    return { sigma, factor, sigmaLow: sigma / factor, lw: Math.ceil(w / factor), lh: Math.ceil(h / factor) };
  };
  return [mk(Math.max(0.6, 0.0012 * L)), mk(Math.max(1.5, 0.01 * L)), mk(Math.max(3, 0.03 * L))];
}

export interface Derived {
  p: EditParams;
  w: number;
  h: number;
  active: Record<StageId, boolean>;
  wb: Vec3;
  expGain: number;
  contrastShape: number;
  tone: [number, number, number, number]; // shadows, highlights, whites, blacks (/100)
  sat: number;
  vib: number;
  local: LocalTables;
  blur: [BlurSpec, BlurSpec, BlurSpec];
  lut: Float32Array;
  mixer: MixerTables;
  grade: GradeTables;
  vignette: VignetteTables;
  grain: GrainTables;
}

const lutCache = new WeakMap<object, Float32Array>();
export function lutFor(p: EditParams): Float32Array {
  let l = lutCache.get(p.curves);
  if (!l) { l = buildLut(p.curves); lutCache.set(p.curves, l); }
  return l;
}

export function derive(p: EditParams, w: number, h: number): Derived {
  const mixer: MixerTables = { hue: [], sat: [], lum: [] };
  for (const c of MIX_COLORS) {
    mixer.hue.push(p[`mix_${c}_hue`] / 100);
    mixer.sat.push(p[`mix_${c}_sat`] / 100);
    mixer.lum.push(p[`mix_${c}_lum`] / 100);
  }
  const grade: GradeTables = {
    a: [], b: [], l: [],
    shift: (-0.25 * p.gradeBalance) / 100,
    width: 0.04 + (0.26 * p.gradeBlending) / 100,
  };
  for (const r of GRADE_RANGES) {
    const hue = (p[`grade_${r}_hue`] * Math.PI) / 180;
    const chroma = (p[`grade_${r}_sat`] / 100) * GRADE_CHROMA;
    grade.a.push(chroma * Math.cos(hue));
    grade.b.push(chroma * Math.sin(hue));
    grade.l.push((p[`grade_${r}_lum`] / 100) * GRADE_LUM_GAIN);
  }
  const L = Math.max(w, h);
  const local: LocalTables = { texture: p.texture / 100, clarity: p.clarity / 100, dehaze: p.dehaze / 100 };
  const active: Record<StageId, boolean> = {
    whiteBalance: p.temperature !== 0 || p.tint !== 0,
    exposure: p.exposure !== 0,
    tone: p.contrast !== 0 || p.highlights !== 0 || p.shadows !== 0 || p.whites !== 0 || p.blacks !== 0,
    local: local.texture !== 0 || local.clarity !== 0 || local.dehaze !== 0,
    curve: !curvesAreIdentity(p.curves),
    mixer: [...mixer.hue, ...mixer.sat, ...mixer.lum].some((v) => v !== 0),
    grading: GRADE_RANGES.some((r) => p[`grade_${r}_sat`] !== 0 || p[`grade_${r}_lum`] !== 0),
    color: p.saturation !== 0 || p.vibrance !== 0,
    vignette: p.vignetteAmount !== 0,
    grain: p.grainAmount !== 0,
  };
  return {
    p, w, h, active,
    wb: wbMultipliers(p.temperature, p.tint),
    expGain: exposureGain(p.exposure),
    contrastShape: contrastShape(p.contrast),
    tone: [p.shadows / 100, p.highlights / 100, p.whites / 100, p.blacks / 100],
    sat: p.saturation / 100,
    vib: p.vibrance / 100,
    local,
    blur: blurPlan(w, h),
    lut: lutFor(p),
    mixer,
    grade,
    vignette: {
      amount: p.vignetteAmount / 100,
      start: p.vignetteMidpoint / 100,
      width: 0.02 + (0.98 * p.vignetteFeather) / 100,
      roundness: p.vignetteRoundness / 100,
      highlights: p.vignetteHighlights / 100,
      aspect: w / h,
    },
    grain: {
      amp: (p.grainAmount / 100) * 0.12,
      cell: Math.max(1, (0.0007 + (0.004 * p.grainSize) / 100) * L),
      rough: p.grainRoughness / 100,
    },
  };
}

export { LUT_SIZE };
