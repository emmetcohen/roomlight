import { linearToSrgb } from './colorSpace';
import { oklchToLinear } from '../image-engine/oklab';

/** OKLCH -> sRGB bytes with a simple gamut clip (for UI swatches only, never for image data). */
export function oklchToRgb8(L: number, C: number, hDeg: number): [number, number, number] {
  const lin = oklchToLinear(L, C, hDeg);
  return [0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, linearToSrgb(lin[i]))) * 255)) as [number, number, number];
}

export function oklchToCss(L: number, C: number, hDeg: number): string {
  const [r, g, b] = oklchToRgb8(L, C, hDeg);
  return `rgb(${r}, ${g}, ${b})`;
}
