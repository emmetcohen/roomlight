/**
 * Pure EditParams → EditParams crop/orientation operations used by the crop tool, so they are
 * testable without any UI. All of them only change parameters; the original is never touched.
 */
import type { EditParams } from '../image-engine/params';
import { fitRatio, fullCrop, presetRatio, fitCropInside, type AspectPreset, type Crop } from './crop';
import { GEO_KEYS, canvasDims, makeGeoMap, rectInsideSource, geoOf } from './transform';

export const modQ = (n: number) => ((n % 4) + 4) % 4;

/** Canvas size in source px for current orientation. */
export const canvasOf = (p: EditParams, sw: number, sh: number) => canvasDims(sw, sh, p.orientation);

/** After a geometry edit, shrink the crop so it never reads outside the original. `aspect` = source width / height. */
export function constrainCrop(next: EditParams, prev: EditParams, aspect: number): EditParams {
  if (GEO_KEYS.every((k) => next[k] === prev[k])) return next;
  const map = makeGeoMap(next, aspect * 1000, 1000);
  const fitted = fitCropInside(next.crop, (r) => rectInsideSource(map, r, 0.05));
  return fitted === next.crop ? next : { ...next, crop: fitted };
}

/** Is the crop rectangle (canvas space) fully inside the original for the current geometry? */
export function cropIsValid(p: EditParams, aspect: number, crop: Crop = p.crop): boolean {
  return rectInsideSource(makeGeoMap(p, aspect * 1000, 1000), crop, 0.05);
}

/** Rotate the picture 90° (+1 clockwise, −1 counter-clockwise); the crop rectangle turns with it. */
export function rotate90(p: EditParams, dir: 1 | -1): EditParams {
  const c = p.crop;
  const crop: Crop = dir === 1
    ? { ...c, x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
    : { ...c, x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  if (c.aspect !== 'free' && c.aspect !== 'original' && c.aspect !== '1:1') crop.portrait = !c.portrait;
  return { ...p, orientation: modQ(p.orientation + dir), crop };
}

/** Flip the picture on screen. (Flips act on the original before the other adjustments.) */
export function flip(p: EditParams, axis: 'h' | 'v'): EditParams {
  const c = p.crop;
  const crop = axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
  // On a quarter-turned canvas, screen-horizontal is the source's vertical axis.
  const sourceAxis = (p.orientation % 2 === 0) === (axis === 'h') ? 'flipH' : 'flipV';
  return { ...p, [sourceAxis]: p[sourceAxis] ? 0 : 1, crop };
}

/** Choose an aspect preset; a locked preset immediately re-fits the current crop. */
export function setAspect(p: EditParams, aspect: AspectPreset, aspectOfSource: number, custom?: { w: number; h: number }): EditParams {
  const cv = canvasOf(p, aspectOfSource * 1000, 1000);
  const crop: Crop = { ...p.crop, aspect, customW: custom?.w ?? p.crop.customW, customH: custom?.h ?? p.crop.customH };
  const ratio = presetRatio(crop, cv.w / cv.h);
  if (ratio === null) return { ...p, crop };
  let fitted = fitRatio(crop, ratio, cv);
  const map = makeGeoMap(p, aspectOfSource * 1000, 1000);
  fitted = fitCropInside(fitted, (r) => rectInsideSource(map, r, 0.05));
  return { ...p, crop: fitted };
}

/** Swap the preset's orientation (landscape ↔ portrait) and re-fit. */
export function swapAspectOrientation(p: EditParams, aspectOfSource: number): EditParams {
  const next = { ...p, crop: { ...p.crop, portrait: !p.crop.portrait } };
  return setAspect(next, next.crop.aspect, aspectOfSource);
}

export function resetCrop(p: EditParams): EditParams { return { ...p, crop: fullCrop() }; }

/** Everything the Crop tool owns: rectangle, orientation, flips and the straighten angle. */
export function resetCropTool(p: EditParams): EditParams {
  return { ...p, crop: fullCrop(), orientation: 0, flipH: 0, flipV: 0, straighten: 0 };
}

export const geometryOf = geoOf;
