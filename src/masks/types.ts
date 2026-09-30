/**
 * Masks. A mask is a greyscale field m(x,y) ∈ [0,1]: 0 = adjustments don't apply, 1 = fully,
 * in between = partially. Each mask carries its own local adjustments and is built from
 * components combined with add / subtract / intersect.
 *
 * Coordinates are "mask space": centred SOURCE pixels divided by the long edge. They are
 * attached to the picture, not to the screen, so masks follow the image through crop,
 * rotate, straighten and perspective edits. (The image spans ±hw × ±hh with hw,hh ≤ 0.5.)
 */
export type MaskOp = 'add' | 'subtract' | 'intersect';

export const LOCAL_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'vibrance', 'saturation', 'texture', 'clarity', 'dehaze',
  'sharpness', 'noise',
] as const;
export type LocalKey = (typeof LOCAL_KEYS)[number];
/** Local keys that are NOT global sliders (their ranges live here; the others come from the slider registry). */
export const LOCAL_EXTRA: Partial<Record<LocalKey, { label: string; min: number; max: number; default: number }>> = {
  sharpness: { label: 'Sharpness', min: -100, max: 100, default: 0 },
  noise: { label: 'Noise', min: 0, max: 100, default: 0 },
};
export type LocalAdjust = Partial<Record<LocalKey, number>>;

export interface BrushPoint { x: number; y: number; p: number } // p: pen pressure 0..1 (1 for mouse)
export interface BrushStroke {
  points: BrushPoint[];
  radius: number; // mask-space units (fraction of the long edge)
  feather: number; // 0..1 — fraction of the radius over which the edge fades
  flow: number; // 0..1 — opacity of each dab (builds up along the stroke)
  density: number; // 0..1 — maximum opacity of the whole stroke
  erase: boolean; // true: removes from what earlier strokes painted
}

export type SegmentKind = 'subject' | 'sky' | 'background';

export type Shape =
  | { type: 'linear'; x1: number; y1: number; x2: number; y2: number; feather: number } // full effect at (x1,y1), none at (x2,y2); feather 0..100
  | { type: 'radial'; cx: number; cy: number; rx: number; ry: number; rotation: number; feather: number } // rotation in degrees, clockwise
  | { type: 'brush'; strokes: BrushStroke[] }
  | { type: 'color'; L: number; a: number; b: number; range: number } // target colour in OKLab; range 0..100
  | { type: 'luminance'; min: number; max: number; smooth: number } // 0..100 (perceptual luminance %), smooth 0..100
  | { type: 'segment'; kind: SegmentKind }; // produced by a segmentation provider (none installed)

export interface MaskComponent {
  id: string;
  op: MaskOp;
  invert: boolean;
  shape: Shape;
}

export interface Mask {
  id: string;
  name: string;
  enabled: boolean;
  invert: boolean;
  /** Overall strength 0..100 (multiplies the final mask). */
  amount: number;
  components: MaskComponent[];
  adjust: LocalAdjust;
}

export const MAX_MASKS = 8;
export const MAX_COMPONENTS = 16; // total across all masks (shader uniform budget)
export const MAX_RASTERS = 8; // brush / segment layers across all masks

let counter = 0;
export const uid = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const SHAPE_LABEL: Record<Shape['type'], string> = {
  linear: 'Linear Gradient', radial: 'Radial Gradient', brush: 'Brush', color: 'Color Range', luminance: 'Luminance Range', segment: 'Segmentation',
};

/** Half extents of the image in mask space. */
export interface Span { hw: number; hh: number }
export const spanOf = (sw: number, sh: number): Span => ({ hw: sw / Math.max(sw, sh) / 2, hh: sh / Math.max(sw, sh) / 2 });

export function newShape(type: Shape['type'], span: Span): Shape {
  switch (type) {
    case 'linear': return { type, x1: 0, y1: -span.hh * 0.85, x2: 0, y2: span.hh * 0.1, feather: 50 };
    case 'radial': return { type, cx: 0, cy: 0, rx: span.hw * 0.5, ry: span.hh * 0.5, rotation: 0, feather: 50 };
    case 'brush': return { type, strokes: [] };
    case 'color': return { type, L: 0.6, a: 0, b: 0, range: 40 };
    case 'luminance': return { type, min: 65, max: 100, smooth: 30 };
    case 'segment': return { type, kind: 'subject' };
  }
}

export const newComponent = (shape: Shape, op: MaskOp = 'add'): MaskComponent => ({ id: uid(), op, invert: false, shape });

export function newMask(shape: Shape, name: string): Mask {
  return { id: uid(), name, enabled: true, invert: false, amount: 100, components: [newComponent(shape)], adjust: {} };
}

/** Validate untrusted masks (from storage). Drops malformed entries instead of throwing. */
export function normalizeMasks(raw: unknown): Mask[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const out: Mask[] = [];
  for (const m of raw.slice(0, MAX_MASKS)) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !Array.isArray(m.components)) continue;
    const components: MaskComponent[] = [];
    for (const c of m.components) {
      const s = c?.shape;
      if (!c || typeof c.id !== 'string' || !s || typeof s !== 'object') continue;
      const op: MaskOp = c.op === 'subtract' || c.op === 'intersect' ? c.op : 'add';
      let shape: Shape | null = null;
      switch (s.type) {
        case 'linear': shape = { type: 'linear', x1: num(s.x1, 0), y1: num(s.y1, 0), x2: num(s.x2, 0), y2: num(s.y2, 0.1), feather: Math.min(100, Math.max(0, num(s.feather, 50))) }; break;
        case 'radial': shape = { type: 'radial', cx: num(s.cx, 0), cy: num(s.cy, 0), rx: Math.max(0.005, num(s.rx, 0.2)), ry: Math.max(0.005, num(s.ry, 0.2)), rotation: num(s.rotation, 0), feather: Math.min(100, Math.max(0, num(s.feather, 50))) }; break;
        case 'brush': shape = { type: 'brush', strokes: Array.isArray(s.strokes) ? s.strokes.filter((k: BrushStroke) => k && Array.isArray(k.points)).map((k: BrushStroke) => ({
          points: k.points.map((p) => ({ x: num(p.x, 0), y: num(p.y, 0), p: Math.min(1, Math.max(0, num(p.p, 1))) })),
          radius: Math.max(0.001, num(k.radius, 0.03)), feather: Math.min(1, Math.max(0, num(k.feather, 0.5))), flow: Math.min(1, Math.max(0, num(k.flow, 1))), density: Math.min(1, Math.max(0, num(k.density, 1))), erase: !!k.erase,
        })) : [] }; break;
        case 'color': shape = { type: 'color', L: num(s.L, 0.6), a: num(s.a, 0), b: num(s.b, 0), range: Math.min(100, Math.max(0, num(s.range, 40))) }; break;
        case 'luminance': shape = { type: 'luminance', min: Math.min(100, Math.max(0, num(s.min, 60))), max: Math.min(100, Math.max(0, num(s.max, 100))), smooth: Math.min(100, Math.max(0, num(s.smooth, 30))) }; break;
        case 'segment': shape = { type: 'segment', kind: s.kind === 'sky' || s.kind === 'background' ? s.kind : 'subject' }; break;
      }
      if (shape) components.push({ id: c.id, op, invert: !!c.invert, shape });
    }
    const adjust: LocalAdjust = {};
    for (const k of LOCAL_KEYS) if (typeof m.adjust?.[k] === 'number' && Number.isFinite(m.adjust[k])) adjust[k] = m.adjust[k];
    out.push({ id: m.id, name: typeof m.name === 'string' ? m.name : 'Mask', enabled: m.enabled !== false, invert: !!m.invert, amount: Math.min(100, Math.max(0, num(m.amount, 100))), components, adjust });
  }
  return out;
}
