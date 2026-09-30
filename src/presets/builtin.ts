/**
 * Built-in presets. Each one is ordinary edit data (the same parameters a person would set by
 * hand), so it can be inspected, tweaked and undone. They are starting points, not "film
 * simulations": nothing here claims to replicate a specific product.
 */
import type { PresetData } from './snapshot';

export interface Preset {
  id: string;
  name: string;
  group: string;
  data: PresetData;
  /** Built-in presets cannot be deleted. */
  builtin?: boolean;
}

const curve = (...pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
const id = (group: string, name: string) => `builtin:${group}:${name}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-');
const mk = (group: string, name: string, data: PresetData): Preset => ({ id: id(group, name), name, group, data, builtin: true });
const identity = curve([0, 0], [1, 1]);

export const BUILTIN_PRESETS: Preset[] = [
  // ---- Color
  mk('Color', 'Vivid', { contrast: 12, vibrance: 35, saturation: 8, clarity: 10 }),
  mk('Color', 'Soft Pastel', { contrast: -22, blacks: 30, highlights: -15, saturation: -8, vibrance: 15 }),
  mk('Color', 'Warm Golden', { temperature: 26, tint: 4, highlights: -18, shadows: 12, vibrance: 14, grade_highlights_hue: 50, grade_highlights_sat: 18 }),
  mk('Color', 'Cool Blue Hour', { temperature: -22, tint: -4, contrast: 8, grade_shadows_hue: 240, grade_shadows_sat: 28, grade_shadows_lum: -6 }),
  mk('Color', 'Teal & Orange', { contrast: 14, vibrance: 12, grade_shadows_hue: 195, grade_shadows_sat: 34, grade_highlights_hue: 45, grade_highlights_sat: 28, gradeBalance: 10 }),
  // ---- Black & White
  mk('Black & White', 'Neutral', { saturation: -100 }),
  mk('Black & White', 'High Contrast', { saturation: -100, contrast: 40, blacks: -16, whites: 14, clarity: 18 }),
  mk('Black & White', 'Matte', { saturation: -100, contrast: -10, blacks: 38, highlights: -12 }),
  mk('Black & White', 'Sepia Tone', { saturation: -100, contrast: 6, grade_global_hue: 48, grade_global_sat: 26 }),
  mk('Black & White', 'Red Filter', { saturation: -100, contrast: 10, mix_red_lum: 45, mix_orange_lum: 30, mix_blue_lum: -45, mix_aqua_lum: -30 }),
  // ---- Film & mood
  mk('Film & Mood', 'Faded Film', {
    curves: { rgb: curve([0, 0.07], [0.25, 0.27], [0.75, 0.78], [1, 0.96]), r: identity, g: identity, b: identity },
    saturation: -12, grainAmount: 28, grainSize: 30, vignetteAmount: -14, vignetteMidpoint: 45,
  }),
  mk('Film & Mood', 'Warm Film', { temperature: 10, contrast: 10, saturation: -6, grade_shadows_hue: 200, grade_shadows_sat: 10, grade_highlights_hue: 55, grade_highlights_sat: 14, grainAmount: 18, grainSize: 28 }),
  mk('Film & Mood', 'Moody Dark', { exposure: -0.35, contrast: 24, highlights: -30, shadows: -10, blacks: -12, saturation: -10, vignetteAmount: -30, vignetteMidpoint: 40 }),
  mk('Film & Mood', 'Bright & Airy', { exposure: 0.4, contrast: -14, highlights: -20, shadows: 28, whites: 12, blacks: 10, vibrance: -6, temperature: 4 }),
  // ---- Detail
  mk('Detail', 'Crisp', { texture: 26, clarity: 16, dehaze: 6 }),
  mk('Detail', 'Soft Glow', { clarity: -32, texture: -14, highlights: -10 }),
  mk('Detail', 'Landscape Punch', { contrast: 14, highlights: -22, shadows: 20, texture: 18, clarity: 14, dehaze: 12, vibrance: 24 }),
  mk('Detail', 'Portrait Soften', { texture: -28, clarity: -10, highlights: -8, vibrance: 6 }),
];

export const PRESET_GROUPS = [...new Set(BUILTIN_PRESETS.map((p) => p.group))];
