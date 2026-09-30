/** Preset thumbnails: the preset applied to the open photo, rendered by the real CPU pipeline at a tiny size. */
import type { AnalysisImage } from '../image-engine/analysis';
import type { EditParams } from '../image-engine/params';
import { renderImage } from '../image-engine/pipeline';
import { applyPreset, type PresetData } from './snapshot';

export interface PreviewSource { data: Uint8ClampedArray; w: number; h: number }

/** Box-downsample the analysis image to at most `max` px on the long edge. */
export function makePreviewSource(a: AnalysisImage, max = 144): PreviewSource {
  const k = Math.min(1, max / Math.max(a.width, a.height)), w = Math.max(1, Math.round(a.width * k)), h = Math.max(1, Math.round(a.height * k));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor((x / w) * a.width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) / w) * a.width)), y0 = Math.floor((y / h) * a.height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) / h) * a.height));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * a.width + xx) * 4; r += a.data[i]; g += a.data[i + 1]; b += a.data[i + 2]; n++; }
    const o = (y * w + x) * 4; data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
  }
  return { data, w, h };
}

/** What clicking the preset would produce, at thumbnail size. */
export function renderPresetPreview(src: PreviewSource, current: EditParams, preset: PresetData): { data: Uint8ClampedArray; width: number; height: number } {
  return renderImage(src.data, src.w, src.h, applyPreset(current, preset));
}
