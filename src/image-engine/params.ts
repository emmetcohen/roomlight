/**
 * Edit parameters and the slider registry.
 *
 * `EditParams` is the *only* thing that describes an edit. The original pixels are never
 * touched; `render(original, edits)` is a pure function of these values.
 *
 * Every scalar slider in the UI is generated from `SLIDERS`, so a control cannot exist
 * without a parameter, a range, a default, and a place in the render pipeline. The tone
 * curve is the one non-scalar parameter (point lists, see curves.ts).
 */
import { oklchToCss } from '../color/oklchCss';
import { curvesAreIdentity, curvesEqual, defaultCurves, normalizeCurves, type ToneCurves } from './curves';

export const MIX_COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type MixColor = (typeof MIX_COLORS)[number];
export const MIX_ATTRS = ['hue', 'sat', 'lum'] as const;
export type MixAttr = (typeof MIX_ATTRS)[number];
export const GRADE_RANGES = ['shadows', 'mid', 'highlights', 'global'] as const;
export type GradeRange = (typeof GRADE_RANGES)[number];
export type MixKey = `mix_${MixColor}_${MixAttr}`;
export type GradeKey = `grade_${GradeRange}_${MixAttr}`;

interface BaseScalars {
  // White balance (relative units; 0 = as shot)
  temperature: number;
  tint: number;
  // Tone
  exposure: number; // stops
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  // Presence (local contrast)
  texture: number;
  clarity: number;
  dehaze: number;
  // Color
  vibrance: number;
  saturation: number;
  // Colour grading global controls
  gradeBlending: number;
  gradeBalance: number;
  // Vignette
  vignetteAmount: number;
  vignetteMidpoint: number;
  vignetteRoundness: number;
  vignetteFeather: number;
  vignetteHighlights: number;
  // Grain
  grainAmount: number;
  grainSize: number;
  grainRoughness: number;
}

export type ScalarParams = BaseScalars & Record<MixKey, number> & Record<GradeKey, number>;
export type ParamKey = keyof ScalarParams;

export interface EditParams extends ScalarParams {
  curves: ToneCurves;
}

export type SectionId =
  | 'whiteBalance' | 'tone' | 'presence' | 'color'
  | 'curve' | 'mixer' | 'grading' | 'vignette' | 'grain';

export interface SliderDef {
  key: ParamKey;
  label: string;
  section: SectionId;
  min: number;
  max: number;
  default: number;
  step: number;
  decimals: number;
  signed: boolean;
  /** CSS gradient stops for the track (colour cues). */
  track?: string;
  /** Unambiguous name for history entries, e.g. "Red Hue". */
  fullLabel: string;
}

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'whiteBalance', label: 'White Balance' },
  { id: 'tone', label: 'Tone' },
  { id: 'presence', label: 'Presence' },
  { id: 'color', label: 'Color' },
  { id: 'curve', label: 'Tone Curve' },
  { id: 'mixer', label: 'Color Mixer' },
  { id: 'grading', label: 'Color Grading' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'grain', label: 'Grain' },
];

/** Display colours for the eight mixer bands (also used for slider tracks). */
export const MIX_SWATCH: Record<MixColor, string> = {
  red: '#e5484d', orange: '#f08a2c', yellow: '#e8c72f', green: '#3fb950',
  aqua: '#2bc4c4', blue: '#3b82f6', purple: '#8b5cf6', magenta: '#d946ef',
};

const s = (
  key: ParamKey, label: string, section: SectionId, min: number, max: number, def = 0,
  o: { step?: number; decimals?: number; signed?: boolean; track?: string; full?: string } = {},
): SliderDef => ({ key, label, section, min, max, default: def, step: o.step ?? 1, decimals: o.decimals ?? 0, signed: o.signed ?? (min < 0), track: o.track, fullLabel: o.full ?? label });

const mixerSliders = (): SliderDef[] =>
  MIX_COLORS.flatMap((c, i) => {
    const prev = MIX_SWATCH[MIX_COLORS[(i + 7) % 8]], self = MIX_SWATCH[c], next = MIX_SWATCH[MIX_COLORS[(i + 1) % 8]];
    const label = c[0].toUpperCase() + c.slice(1);
    return [
      s(`mix_${c}_hue`, label, 'mixer', -100, 100, 0, { track: `${prev}, ${self}, ${next}`, full: `${label} Hue` }),
      s(`mix_${c}_sat`, label, 'mixer', -100, 100, 0, { track: `#8a8a8a, ${self}`, full: `${label} Saturation` }),
      s(`mix_${c}_lum`, label, 'mixer', -100, 100, 0, { track: `#000, ${self}, #fff`, full: `${label} Luminance` }),
    ];
  });

export const GRADE_LABEL: Record<GradeRange, string> = { shadows: 'Shadows', mid: 'Midtones', highlights: 'Highlights', global: 'Global' };
const HUE_TRACK = [0, 60, 120, 180, 240, 300, 360].map((h) => oklchToCss(0.72, 0.13, h)).join(', ');

const gradingSliders = (): SliderDef[] =>
  GRADE_RANGES.flatMap((r) => [
    s(`grade_${r}_hue`, 'Hue', 'grading', 0, 360, 0, { signed: false, track: HUE_TRACK, full: `${GRADE_LABEL[r]} Hue` }),
    s(`grade_${r}_sat`, 'Saturation', 'grading', 0, 100, 0, { signed: false, full: `${GRADE_LABEL[r]} Saturation` }),
    s(`grade_${r}_lum`, 'Luminance', 'grading', -100, 100, 0, { full: `${GRADE_LABEL[r]} Luminance` }),
  ]);

export const SLIDERS: SliderDef[] = [
  s('temperature', 'Temp', 'whiteBalance', -100, 100, 0, { track: '#4a7dff, #c9c9c9, #ffb13d' }),
  s('tint', 'Tint', 'whiteBalance', -100, 100, 0, { track: '#3fcf6e, #c9c9c9, #e04fd0' }),

  s('exposure', 'Exposure', 'tone', -5, 5, 0, { step: 0.01, decimals: 2 }),
  s('contrast', 'Contrast', 'tone', -100, 100),
  s('highlights', 'Highlights', 'tone', -100, 100),
  s('shadows', 'Shadows', 'tone', -100, 100),
  s('whites', 'Whites', 'tone', -100, 100),
  s('blacks', 'Blacks', 'tone', -100, 100),

  s('texture', 'Texture', 'presence', -100, 100),
  s('clarity', 'Clarity', 'presence', -100, 100),
  s('dehaze', 'Dehaze', 'presence', -100, 100),

  s('vibrance', 'Vibrance', 'color', -100, 100),
  s('saturation', 'Saturation', 'color', -100, 100),

  ...mixerSliders(),
  ...gradingSliders(),
  s('gradeBlending', 'Blending', 'grading', 0, 100, 50, { signed: false, full: 'Grading Blending' }),
  s('gradeBalance', 'Balance', 'grading', -100, 100, 0, { full: 'Grading Balance' }),

  s('vignetteAmount', 'Amount', 'vignette', -100, 100, 0, { full: 'Vignette Amount' }),
  s('vignetteMidpoint', 'Midpoint', 'vignette', 0, 100, 50, { signed: false, full: 'Vignette Midpoint' }),
  s('vignetteRoundness', 'Roundness', 'vignette', -100, 100, 0, { full: 'Vignette Roundness' }),
  s('vignetteFeather', 'Feather', 'vignette', 0, 100, 50, { signed: false, full: 'Vignette Feather' }),
  s('vignetteHighlights', 'Highlights', 'vignette', 0, 100, 0, { signed: false, full: 'Vignette Highlights' }),

  s('grainAmount', 'Amount', 'grain', 0, 100, 0, { signed: false, full: 'Grain Amount' }),
  s('grainSize', 'Size', 'grain', 0, 100, 25, { signed: false, full: 'Grain Size' }),
  s('grainRoughness', 'Roughness', 'grain', 0, 100, 50, { signed: false, full: 'Grain Roughness' }),
];

export const SLIDER_BY_KEY = Object.fromEntries(SLIDERS.map((d) => [d.key, d])) as Record<ParamKey, SliderDef>;

export const DEFAULT_PARAMS: EditParams = Object.freeze({
  ...(Object.fromEntries(SLIDERS.map((d) => [d.key, d.default])) as unknown as ScalarParams),
  curves: defaultCurves(),
}) as EditParams;

export function clampParam(key: ParamKey, value: number): number {
  const d = SLIDER_BY_KEY[key];
  if (!Number.isFinite(value)) return d.default;
  return Math.min(d.max, Math.max(d.min, value));
}

/**
 * Merge stored/partial parameters onto the defaults. Unknown keys are dropped and every
 * value is clamped/validated, so edits saved by older or newer versions load safely.
 */
export function normalizeParams(partial: Partial<Record<string, unknown>> | undefined | null): EditParams {
  const out = { ...DEFAULT_PARAMS, curves: defaultCurves() } as EditParams;
  if (!partial) return out;
  for (const d of SLIDERS) {
    const v = partial[d.key];
    if (typeof v === 'number') (out as unknown as Record<string, number>)[d.key] = clampParam(d.key, v);
  }
  out.curves = normalizeCurves(partial.curves);
  return out;
}

export function paramsEqual(a: EditParams, b: EditParams): boolean {
  if (a === b) return true;
  for (const d of SLIDERS) if (a[d.key] !== b[d.key]) return false;
  return curvesEqual(a.curves, b.curves);
}

/** True if every scalar (optionally just `keys`) is at its default — and curves too when no keys given. */
export function isDefault(params: EditParams, keys?: ParamKey[]): boolean {
  for (const d of SLIDERS) {
    if (keys && !keys.includes(d.key)) continue;
    if (params[d.key] !== d.default) return false;
  }
  return keys ? true : curvesAreIdentity(params.curves);
}

export function keysOfSection(section: SectionId): ParamKey[] {
  return SLIDERS.filter((d) => d.section === section).map((d) => d.key);
}

export function formatParam(key: ParamKey, value: number): string {
  const d = SLIDER_BY_KEY[key];
  const fixed = value.toFixed(d.decimals);
  return d.signed && value > 0 ? `+${fixed}` : fixed;
}
