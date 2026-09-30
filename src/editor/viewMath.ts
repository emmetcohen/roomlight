/**
 * Zoom / pan arithmetic (pure). Units:
 *   z        device pixels per image pixel (1 = 100 %)
 *   (cx, cy) centre of the window in output uv (0..1, y down)
 *   region   the window as output-uv rectangle {ox, oy, sx, sy}; identity = whole picture
 */
export interface ViewRect { ox: number; oy: number; sx: number; sy: number }
export const IDENTITY_VIEW: ViewRect = { ox: 0, oy: 0, sx: 1, sy: 1 };
export const MAX_Z = 4;

/** z at which the whole picture just fits a canvas of (boxW × boxH) device pixels. */
export const fitScale = (nativeW: number, nativeH: number, boxW: number, boxH: number): number => Math.min(boxW / nativeW, boxH / nativeH);

/** The window for zoom z centred on (cx, cy), drawn into a canvas of (pw × ph) device px. The centre is clamped so the window never leaves the picture (a window bigger than the picture is centred). */
export function regionFor(z: number, cx: number, cy: number, nativeW: number, nativeH: number, pw: number, ph: number): ViewRect & { cx: number; cy: number } {
  const sx = pw / (z * nativeW), sy = ph / (z * nativeH);
  const clamp = (c: number, s: number) => (s >= 1 ? 0.5 : Math.min(1 - s / 2, Math.max(s / 2, c)));
  const x = clamp(cx, sx), y = clamp(cy, sy);
  return { ox: x - sx / 2, oy: y - sy / 2, sx, sy, cx: x, cy: y };
}

/** Zoom by `factor` keeping the picture point under the cursor fixed. (au, av) = cursor as a fraction of the canvas (0..1). Returns z = null (fit) when zooming out to the fit size. */
export function zoomAt(
  cur: { z: number | null; cx: number; cy: number }, factor: number, au: number, av: number,
  nativeW: number, nativeH: number, pw: number, ph: number, zFit: number,
): { z: number | null; cx: number; cy: number } {
  const z0 = cur.z ?? zFit;
  const z1 = Math.min(MAX_Z, z0 * factor);
  if (z1 <= zFit * 1.0001) return { z: null, cx: 0.5, cy: 0.5 };
  const r0 = cur.z === null ? IDENTITY_VIEW : regionFor(z0, cur.cx, cur.cy, nativeW, nativeH, pw, ph);
  const u = r0.ox + au * r0.sx, v = r0.oy + av * r0.sy; // picture point under the cursor
  const sx1 = pw / (z1 * nativeW), sy1 = ph / (z1 * nativeH);
  const r1 = regionFor(z1, u - au * sx1 + sx1 / 2, v - av * sy1 + sy1 / 2, nativeW, nativeH, pw, ph);
  return { z: z1, cx: r1.cx, cy: r1.cy };
}

/** Drag by (dx, dy) device pixels: the picture follows the pointer. */
export function panBy(z: number, cx: number, cy: number, dx: number, dy: number, nativeW: number, nativeH: number, pw: number, ph: number): { cx: number; cy: number } {
  const r = regionFor(z, cx - dx / (z * nativeW), cy - dy / (z * nativeH), nativeW, nativeH, pw, ph);
  return { cx: r.cx, cy: r.cy };
}

/** Screen fraction (0..1 across the canvas) → output uv, and back. */
export const screenToOutput = (v: ViewRect, fx: number, fy: number): [number, number] => [v.ox + fx * v.sx, v.oy + fy * v.sy];
export const outputToScreen = (v: ViewRect, u: number, w: number): [number, number] => [(u - v.ox) / v.sx, (w - v.oy) / v.sy];
