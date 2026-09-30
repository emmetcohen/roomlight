/**
 * Crop rectangle (normalised, in canvas space) + aspect presets + pure drag logic.
 * The crop is just four numbers: the original pixels are never touched.
 */
export type AspectPreset = 'free' | 'original' | '1:1' | '4:5' | '3:2' | '4:3' | '16:9' | 'custom';
export const ASPECT_PRESETS: { id: AspectPreset; label: string }[] = [
  { id: 'free', label: 'Free' }, { id: 'original', label: 'Original' }, { id: '1:1', label: '1 : 1' }, { id: '4:5', label: '4 : 5' },
  { id: '3:2', label: '3 : 2' }, { id: '4:3', label: '4 : 3' }, { id: '16:9', label: '16 : 9' }, { id: 'custom', label: 'Custom' },
];

export interface Crop {
  x: number; y: number; w: number; h: number;
  aspect: AspectPreset;
  customW: number; customH: number;
  /** Swap the preset's orientation (4:5 <-> 5:4). */
  portrait: boolean;
}

export const FULL_CROP: Crop = Object.freeze({ x: 0, y: 0, w: 1, h: 1, aspect: 'free', customW: 1, customH: 1, portrait: false }) as Crop;
export const fullCrop = (): Crop => ({ ...FULL_CROP });
export const MIN_CROP = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const isFullCrop = (c: Crop) => c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;

export function normalizeCrop(raw: unknown): Crop {
  if (!raw || typeof raw !== 'object') return fullCrop();
  const r = raw as Partial<Crop>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  let w = clamp(num(r.w, 1), MIN_CROP, 1), h = clamp(num(r.h, 1), MIN_CROP, 1);
  const x = clamp(num(r.x, 0), 0, 1 - w), y = clamp(num(r.y, 0), 0, 1 - h);
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  const aspect = ASPECT_PRESETS.some((a) => a.id === r.aspect) ? (r.aspect as AspectPreset) : 'free';
  return { x, y, w, h, aspect, customW: clamp(num(r.customW, 1), 0.01, 1000), customH: clamp(num(r.customH, 1), 0.01, 1000), portrait: !!r.portrait };
}

/** Pixel aspect ratio (width / height) a preset asks for, or null for Free. */
export function presetRatio(c: Pick<Crop, 'aspect' | 'customW' | 'customH' | 'portrait'>, canvasAspect: number): number | null {
  let r: number | null;
  switch (c.aspect) {
    case 'free': return null;
    case 'original': return canvasAspect; // orientation swap is meaningless here
    case '1:1': return 1;
    case '4:5': r = 4 / 5; break;
    case '3:2': r = 3 / 2; break;
    case '4:3': r = 4 / 3; break;
    case '16:9': r = 16 / 9; break;
    case 'custom': r = c.customW / c.customH; break;
  }
  // Presets are quoted as landscape except 4:5, which is conventionally portrait; `portrait` flips the orientation.
  if (c.aspect === '4:5') return c.portrait ? 5 / 4 : 4 / 5;
  return c.portrait ? 1 / r : r;
}

/** Largest rectangle of pixel ratio `ratio` that fits inside `crop`, sharing its centre. */
export function fitRatio(crop: Crop, ratio: number, canvas: { w: number; h: number }): Crop {
  const cw = crop.w * canvas.w, ch = crop.h * canvas.h;
  let w = cw, h = ch;
  if (cw / ch > ratio) w = ch * ratio; else h = cw / ratio;
  const nw = w / canvas.w, nh = h / canvas.h;
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  return { ...crop, x: clamp(cx - nw / 2, 0, 1 - nw), y: clamp(cy - nh / 2, 0, 1 - nh), w: nw, h: nh };
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * New crop for dragging `handle` by (dx, dy) — normalised canvas units, measured from the crop
 * at drag start. With `ratio` (pixel w/h) the aspect is locked: corners keep the opposite corner
 * fixed; edges resize symmetrically about the perpendicular centre line.
 */
export function dragCrop(start: Crop, handle: CropHandle, dx: number, dy: number, ratio: number | null, canvas: { w: number; h: number }): Crop {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (handle.includes('w')) l = clamp(l + dx, 0, r - MIN_CROP);
  if (handle.includes('e')) r = clamp(r + dx, l + MIN_CROP, 1);
  if (handle.includes('n')) t = clamp(t + dy, 0, b - MIN_CROP);
  if (handle.includes('s')) b = clamp(b + dy, t + MIN_CROP, 1);
  if (ratio === null) return { ...start, x: l, y: t, w: r - l, h: b - t };

  const k = ratio * canvas.h / canvas.w; // normalised w = k · normalised h
  const corner = handle.length === 2;
  let w = r - l, h = b - t;
  if (corner) {
    // follow whichever dimension the pointer pulled further, then clamp to the room available
    if (w / k > h) h = w / k; else w = h * k;
    const roomW = handle.includes('w') ? start.x + start.w : 1 - start.x;
    const roomH = handle.includes('n') ? start.y + start.h : 1 - start.y;
    const s = Math.min(1, roomW / w, roomH / h);
    w *= s; h *= s;
    if (w < MIN_CROP || h < MIN_CROP) { w = Math.max(w, MIN_CROP); h = w / k; }
    const nx = handle.includes('w') ? start.x + start.w - w : start.x;
    const ny = handle.includes('n') ? start.y + start.h - h : start.y;
    return { ...start, x: nx, y: ny, w, h };
  }
  if (handle === 'e' || handle === 'w') {
    h = w / k;
    const cy = start.y + start.h / 2;
    const maxH = 2 * Math.min(cy, 1 - cy);
    if (h > maxH) { h = maxH; w = h * k; }
    const nx = handle === 'w' ? start.x + start.w - w : start.x;
    return { ...start, x: nx, y: cy - h / 2, w, h };
  }
  w = h * k;
  const cx = start.x + start.w / 2;
  const maxW = 2 * Math.min(cx, 1 - cx);
  if (w > maxW) { w = maxW; h = w / k; }
  const ny = handle === 'n' ? start.y + start.h - h : start.y;
  return { ...start, x: cx - w / 2, y: ny, w, h };
}

/**
 * Keep a crop inside the valid image area (e.g. after Straighten): if any corner reads from
 * outside the source, shrink about the centre (bisection) — falling back to a centred rectangle.
 */
export function fitCropInside(crop: Crop, inside: (r: { x: number; y: number; w: number; h: number }) => boolean): Crop {
  if (inside(crop)) return crop;
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  const about = (px: number, py: number, s: number) => ({ x: px - (crop.w * s) / 2, y: py - (crop.h * s) / 2, w: crop.w * s, h: crop.h * s });
  const bisect = (px: number, py: number) => {
    if (!inside(about(px, py, 0.02))) return 0;
    let lo = 0.02, hi = 1;
    for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (inside(about(px, py, mid))) lo = mid; else hi = mid; }
    return lo;
  };
  let s = bisect(cx, cy), px = cx, py = cy;
  if (s === 0) { px = 0.5; py = 0.5; s = bisect(px, py); }
  if (s === 0) return { ...crop, x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  const r = about(px, py, s);
  return { ...crop, x: clamp(r.x, 0, 1 - r.w), y: clamp(r.y, 0, 1 - r.h), w: r.w, h: r.h };
}
