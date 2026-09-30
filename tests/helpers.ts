/** Small deterministic RGBA8 test scene: gradients, colour patches, hard edges, fine texture. */
export const SCENE_W = 48;
export const SCENE_H = 36;

export function scene(w = SCENE_W, h = SCENE_H): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  const cols = [[220, 50, 50], [240, 140, 40], [230, 210, 50], [60, 180, 80], [50, 190, 200], [60, 90, 220], [140, 70, 210], [220, 70, 190]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r: number, g: number, b: number;
    if (y < h * 0.4) { const t = y / (h * 0.4); r = 40 + 180 * t; g = 95 + 130 * t; b = 175 + 60 * t; }
    else if (y < h * 0.75) { const t = (y - h * 0.4) / (h * 0.35); r = 140 - 90 * t; g = 105 - 70 * t; b = 60 - 40 * t; }
    else { const v = Math.round((x / (w - 1)) * 255); r = g = b = v; }
    if (y >= h * 0.5 && y < h * 0.7) { const c = Math.floor(x / (w / 8)); if (x % Math.round(w / 8) < w / 8 - 2) [r, g, b] = cols[Math.min(c, 7)]; }
    if (x > w * 0.3 && x < w * 0.55 && y > 2 && y < h * 0.35) { r = 235; g = 232; b = 225; }
    if (((x >> 1) + (y >> 1)) % 2 === 0 && y > 4 && y < 14 && x > w * 0.65) { r *= 0.8; g *= 0.8; b *= 0.8; }
    const o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}

export const mean = (d: ArrayLike<number>, ch: number) => { let s = 0, n = 0; for (let i = ch; i < d.length; i += 4) { s += d[i]; n++; } return s / n; };
export const stddev = (d: ArrayLike<number>, ch: number) => { const m = mean(d, ch); let s = 0, n = 0; for (let i = ch; i < d.length; i += 4) { s += (d[i] - m) ** 2; n++; } return Math.sqrt(s / n); };
export const px = (d: ArrayLike<number>, w: number, x: number, y: number) => { const o = (y * w + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
