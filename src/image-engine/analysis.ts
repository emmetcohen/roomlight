/** CPU-side analysis of a small copy of the original (auto white balance, eyedropper). */
import { srgbToLinear, type Vec3 } from '../color/colorSpace';
import { solveWhiteBalance } from './model';

export interface AnalysisImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA8 of the *unedited* original
}

export function makeAnalysisImage(bitmap: ImageBitmap, maxDim = 384): AnalysisImage {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

const LUT = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));

/** Mean linear-light RGB in a square neighbourhood. (u,v) are normalised image coords, v down. */
export function sampleLinear(img: AnalysisImage, u: number, v: number, radius = 2): Vec3 {
  const cx = Math.round(u * (img.width - 1));
  const cy = Math.round(v * (img.height - 1));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(img.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(img.width - 1, cx + radius); x++) {
      const i = (y * img.width + x) * 4;
      r += LUT[img.data[i]]; g += LUT[img.data[i + 1]]; b += LUT[img.data[i + 2]]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** Grey-world estimate: assume the scene averages to neutral. Clipped / near-black pixels are ignored. */
export function grayWorldNeutral(img: AnalysisImage): Vec3 | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
    const mx = Math.max(R, G, B);
    if (mx < 12 || mx > 250) continue;
    r += LUT[R]; g += LUT[G]; b += LUT[B]; n++;
  }
  return n === 0 ? null : [r / n, g / n, b / n];
}

export function autoWhiteBalance(img: AnalysisImage): { temperature: number; tint: number } | null {
  const neutral = grayWorldNeutral(img);
  return neutral ? solveWhiteBalance(neutral) : null;
}
