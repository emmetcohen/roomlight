/**
 * Geometry: one projective transform from the ORIGINAL image to the output, plus the crop.
 *
 * Coordinates: pixels, origin at the image centre, +x right, +y DOWN (so a positive angle
 * rotates clockwise on screen). "source" = the decoded original; "canvas" = the source after
 * orientation (90° turns / flips) — the space the crop rectangle is expressed in (normalised 0..1).
 *
 * Forward model (source → canvas), applied right to left to a source point p:
 *     M = T · Rs · S · A · P · Rg · O
 *   O  orientation: flips, then k × 90° clockwise turns (canvas size swaps for odd k)
 *   Rg "Rotate" (Geometry panel, ±10°)
 *   P  perspective: third row (h/Rn, v/Rn, 1), h = Horizontal·0.35/100, v = Vertical·0.35/100,
 *      Rn = half-diagonal of the canvas (so the effect is resolution independent).
 *      x' = x/w, y' = y/w with w = 1 + (h·x + v·y)/Rn.  +Vertical makes the TOP wider /
 *      the bottom narrower (corrects a building photographed from below).
 *   A  aspect squeeze: x × 2^(0.4·Aspect/100), y ÷ the same (area preserving)
 *   S  scale (50–150 %)
 *   Rs straighten (crop angle, ±45°)
 *   T  offset: X/Y × 0.5 × canvas size / 100
 *
 * Rendering uses the INVERSE: for every output pixel, find where to read the original
 * (inverse mapping — no holes, one bilinear read). Nothing ever modifies the original.
 * The lens model (distortion, chromatic aberration) acts afterwards on the source position.
 */
import { deepEqual } from '../utils/deepEqual';
import type { Crop } from './crop';

export type Mat3 = number[]; // row-major, length 9

export interface GeoParams {
  straighten: number;
  geoRotate: number;
  geoVertical: number;
  geoHorizontal: number;
  geoAspect: number;
  geoScale: number;
  geoOffsetX: number;
  geoOffsetY: number;
  orientation: number; // 0..3 quarter turns clockwise
  flipH: number; // 0 | 1
  flipV: number; // 0 | 1
}

export const GEO_KEYS: (keyof GeoParams)[] = [
  'straighten', 'geoRotate', 'geoVertical', 'geoHorizontal', 'geoAspect', 'geoScale', 'geoOffsetX', 'geoOffsetY', 'orientation', 'flipH', 'flipV',
];
export const DEFAULT_GEO: GeoParams = {
  straighten: 0, geoRotate: 0, geoVertical: 0, geoHorizontal: 0, geoAspect: 0, geoScale: 100, geoOffsetX: 0, geoOffsetY: 0, orientation: 0, flipH: 0, flipV: 0,
};
export const PERSPECTIVE_STRENGTH = 0.35;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return IDENTITY.slice();
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

/** Project (x, y) through a homography. Returns null when the point goes behind the plane (w ≤ 0). */
export function project(m: Mat3, x: number, y: number): [number, number] | null {
  const w = m[6] * x + m[7] * y + m[8];
  if (w <= 1e-9) return null;
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

const rot = (deg: number): Mat3 => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
const scl = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
const trn = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];

/** Canvas size in source pixels after orientation. */
export function canvasDims(sw: number, sh: number, orientation: number): { w: number; h: number } {
  return orientation % 2 === 1 ? { w: sh, h: sw } : { w: sw, h: sh };
}

export function geoMatrix(g: GeoParams, sw: number, sh: number): Mat3 {
  const cv = canvasDims(sw, sh, g.orientation);
  const Rn = Math.hypot(cv.w, cv.h) / 2;
  let O = IDENTITY;
  if (g.flipH) O = mul3(scl(-1, 1), O);
  if (g.flipV) O = mul3(scl(1, -1), O);
  O = mul3(rot(90 * (((g.orientation % 4) + 4) % 4)), O);
  const P: Mat3 = [1, 0, 0, 0, 1, 0, ((g.geoHorizontal / 100) * PERSPECTIVE_STRENGTH) / Rn, ((g.geoVertical / 100) * PERSPECTIVE_STRENGTH) / Rn, 1];
  const sx = Math.pow(2, (0.4 * g.geoAspect) / 100);
  const s = g.geoScale / 100;
  let M = mul3(rot(g.geoRotate), O);
  M = mul3(P, M);
  M = mul3(scl(sx, 1 / sx), M);
  M = mul3(scl(s, s), M);
  M = mul3(rot(g.straighten), M);
  return mul3(trn((g.geoOffsetX / 100) * 0.5 * cv.w, (g.geoOffsetY / 100) * 0.5 * cv.h), M);
}

export function isGeoIdentity(g: GeoParams): boolean {
  return GEO_KEYS.every((k) => g[k] === DEFAULT_GEO[k]);
}

export function geoOf(p: GeoParams): GeoParams {
  const g = {} as GeoParams;
  for (const k of GEO_KEYS) g[k] = p[k];
  return g;
}

/** Everything a renderer needs to map output pixels to source positions. */
export interface GeoMap {
  active: boolean; // false => output uv == source uv exactly
  inv: Mat3; // canvas px (centred) -> source px (centred)
  fwd: Mat3;
  crop: { x: number; y: number; w: number; h: number };
  canvas: { w: number; h: number };
  src: { w: number; h: number };
  /** Mask-space scale: mask coordinates are source pixels divided by this (the long edge). */
  L: number;
}

export function makeGeoMap(p: GeoParams & { crop: Crop }, sw: number, sh: number): GeoMap {
  const fwd = geoMatrix(p, sw, sh);
  const crop = { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h };
  const full = crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
  return {
    active: !isGeoIdentity(p) || !full,
    fwd, inv: inv3(fwd), crop,
    canvas: canvasDims(sw, sh, p.orientation),
    src: { w: sw, h: sh },
    L: Math.max(sw, sh),
  };
}

/** Output uv (0..1, y down) -> centred source pixels, or null if the transform has no finite preimage. */
export function outputToSource(m: GeoMap, u: number, v: number): [number, number] | null {
  if (!m.active) return [(u - 0.5) * m.src.w, (v - 0.5) * m.src.h];
  const gx = m.crop.x + u * m.crop.w, gy = m.crop.y + v * m.crop.h;
  return project(m.inv, (gx - 0.5) * m.canvas.w, (gy - 0.5) * m.canvas.h);
}

/** Centred source pixels -> output uv (0..1 over the CROP), or null. */
export function sourceToOutput(m: GeoMap, x: number, y: number): [number, number] | null {
  const q = project(m.fwd, x, y);
  if (!q) return null;
  const gx = q[0] / m.canvas.w + 0.5, gy = q[1] / m.canvas.h + 0.5;
  return [(gx - m.crop.x) / m.crop.w, (gy - m.crop.y) / m.crop.h];
}

/** Mask space: centred source pixels / long edge. So the image spans ±hw × ±hh with hw,hh ≤ 0.5. */
export const toMaskSpace = (m: GeoMap, x: number, y: number): [number, number] => [x / m.L, y / m.L];
export const fromMaskSpace = (m: GeoMap, x: number, y: number): [number, number] => [x * m.L, y * m.L];

/** Output uv -> mask space / back (what the mask tools use to place handles on screen). */
export function outputToMask(m: GeoMap, u: number, v: number): [number, number] | null {
  const s = outputToSource(m, u, v);
  return s ? toMaskSpace(m, s[0], s[1]) : null;
}
export function maskToOutput(m: GeoMap, x: number, y: number): [number, number] | null {
  const [sx, sy] = fromMaskSpace(m, x, y);
  return sourceToOutput(m, sx, sy);
}

/** Output pixel size for a crop, given a long-edge limit (maxDim) or 1:1 with the source. */
export function outputSize(p: GeoParams & { crop: Crop }, sw: number, sh: number, maxDim?: number): { w: number; h: number } {
  const cv = canvasDims(sw, sh, p.orientation);
  let w = p.crop.w * cv.w, h = p.crop.h * cv.h;
  if (maxDim && Math.max(w, h) > maxDim) { const k = maxDim / Math.max(w, h); w *= k; h *= k; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** True if all four corners of a canvas-space rect (normalised) read from inside the source. */
export function rectInsideSource(m: GeoMap, r: { x: number; y: number; w: number; h: number }, slack = 0.5): boolean {
  for (const [cx, cy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const s = project(m.inv, (cx - 0.5) * m.canvas.w, (cy - 0.5) * m.canvas.h);
    if (!s) return false;
    if (Math.abs(s[0]) > m.src.w / 2 + slack || Math.abs(s[1]) > m.src.h / 2 + slack) return false;
  }
  return true;
}

export const geoEqual = (a: GeoParams, b: GeoParams) => deepEqual(geoOf(a), geoOf(b));
