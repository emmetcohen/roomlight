/**
 * Edit parameters and the slider registry.
 *
 * `EditParams` is the *only* thing that describes an edit. The original pixels are never
 * touched; `render(original, edits)` is a pure function of these numbers.
 *
 * Every slider in the UI is generated from `SLIDERS`, so a control cannot exist without a
 * parameter, a range, a default, and a place in the render pipeline.
 */

export interface EditParams {
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
  // Color
  vibrance: number;
  saturation: number;
}

export type ParamKey = keyof EditParams;

export type SectionId = 'whiteBalance' | 'tone' | 'color';

export interface SliderDef {
  key: ParamKey;
  label: string;
  section: SectionId;
  min: number;
  max: number;
  default: number;
  /** Step for the native range input / number field. */
  step: number;
  /** Decimal places shown. */
  decimals: number;
  /** Show a sign (+/-) in front of positive values. */
  signed: boolean;
  /** Optional track gradient hint (CSS gradient stops) for white balance. */
  track?: string;
}

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'whiteBalance', label: 'White Balance' },
  { id: 'tone', label: 'Tone' },
  { id: 'color', label: 'Color' },
];

export const SLIDERS: SliderDef[] = [
  { key: 'temperature', label: 'Temp', section: 'whiteBalance', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true, track: '#4a7dff, #c9c9c9, #ffb13d' },
  { key: 'tint', label: 'Tint', section: 'whiteBalance', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true, track: '#3fcf6e, #c9c9c9, #e04fd0' },

  { key: 'exposure', label: 'Exposure', section: 'tone', min: -5, max: 5, default: 0, step: 0.01, decimals: 2, signed: true },
  { key: 'contrast', label: 'Contrast', section: 'tone', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
  { key: 'highlights', label: 'Highlights', section: 'tone', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
  { key: 'shadows', label: 'Shadows', section: 'tone', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
  { key: 'whites', label: 'Whites', section: 'tone', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
  { key: 'blacks', label: 'Blacks', section: 'tone', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },

  { key: 'vibrance', label: 'Vibrance', section: 'color', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
  { key: 'saturation', label: 'Saturation', section: 'color', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true },
];

export const SLIDER_BY_KEY = Object.fromEntries(SLIDERS.map((s) => [s.key, s])) as Record<ParamKey, SliderDef>;

export const DEFAULT_PARAMS: EditParams = Object.freeze(
  Object.fromEntries(SLIDERS.map((s) => [s.key, s.default])) as unknown as EditParams,
);

export function clampParam(key: ParamKey, value: number): number {
  const d = SLIDER_BY_KEY[key];
  if (!Number.isFinite(value)) return d.default;
  return Math.min(d.max, Math.max(d.min, value));
}

/**
 * Merge stored/partial parameters onto the defaults. Unknown keys are dropped and every
 * value is clamped, so edits saved by older or newer versions load safely.
 */
export function normalizeParams(partial: Partial<Record<string, unknown>> | undefined | null): EditParams {
  const out = { ...DEFAULT_PARAMS } as EditParams;
  if (!partial) return out;
  for (const s of SLIDERS) {
    const v = partial[s.key];
    if (typeof v === 'number') out[s.key] = clampParam(s.key, v);
  }
  return out;
}

export function paramsEqual(a: EditParams, b: EditParams): boolean {
  for (const s of SLIDERS) if (a[s.key] !== b[s.key]) return false;
  return true;
}

export function isDefault(params: EditParams, keys?: ParamKey[]): boolean {
  for (const s of SLIDERS) {
    if (keys && !keys.includes(s.key)) continue;
    if (params[s.key] !== s.default) return false;
  }
  return true;
}

export function keysOfSection(section: SectionId): ParamKey[] {
  return SLIDERS.filter((s) => s.section === section).map((s) => s.key);
}

export function formatParam(key: ParamKey, value: number): string {
  const d = SLIDER_BY_KEY[key];
  const fixed = value.toFixed(d.decimals);
  return d.signed && value > 0 ? `+${fixed}` : fixed;
}
