/** Real histogram of rendered RGBA8 pixels. */

export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  pixels: number;
  /** Fraction of pixels with any channel at 255 / any channel at 0. */
  clipHigh: number;
  clipLow: number;
}

export function computeHistogram(rgba: Uint8Array | Uint8ClampedArray): HistogramData {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), luma = new Uint32Array(256);
  let hi = 0, lo = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
    r[R]++; g[G]++; b[B]++;
    // Rec.709 luma of the encoded values (what display-referred histograms conventionally show).
    luma[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    if (R === 255 || G === 255 || B === 255) hi++;
    if (R === 0 || G === 0 || B === 0) lo++;
  }
  return { r, g, b, luma, pixels: n, clipHigh: n ? hi / n : 0, clipLow: n ? lo / n : 0 };
}
