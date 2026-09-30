/**
 * Output sharpening: an unsharp mask on LUMINANCE only (so it cannot create colour fringes),
 * applied to the final 8-bit sRGB pixels after resizing — the usual place for it.
 *
 *   Y  = 0.2126 R + 0.7152 G + 0.0722 B          (encoded values, 0..255)
 *   Yb = Gaussian blur of Y with σ (separable, radius 3σ, clamp-to-edge)
 *   c' = clamp(c + g · (Y − Yb)),  g = 1.5 · amount/100    for R, G and B alike
 *
 * Alpha is left alone. amount = 0 returns the input unchanged.
 */
export function sharpenInPlace(rgba: Uint8ClampedArray, w: number, h: number, amount: number, sigma: number): void {
  if (amount <= 0 || sigma <= 0) return;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(n), blur = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * Y[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    blur[y * w + x] = s;
  }
  const g = 1.5 * (amount / 100);
  for (let i = 0; i < n; i++) {
    const d = g * (Y[i] - blur[i]);
    rgba[i * 4] += d; rgba[i * 4 + 1] += d; rgba[i * 4 + 2] += d; // Uint8ClampedArray rounds and clamps
  }
}
