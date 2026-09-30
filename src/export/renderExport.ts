/**
 * Full-resolution export of one photo. Runs identically in a Web Worker (OffscreenCanvas) or on
 * the main thread, so the UI never freezes during a big export.
 *
 *   original file ─► decode at full size (orientation applied) ─► retouch spots
 *   ─► GPU render of the real pipeline at the OUTPUT size (crop, geometry, lens, masks, ...)
 *   ─► un-premultiply ─► output sharpening ─► flatten (JPEG) ─► encode ─► embed metadata (JPEG)
 *
 * The edit parameters are applied to the ORIGINAL file's pixels; nothing is upscaled from the
 * on-screen preview. Limits (GPU texture size, pixel budget) are reported in `notes`, never hidden.
 */
import { outputSize } from '../geometry/transform';
import type { EditParams } from '../image-engine/params';
import { WebGLRenderer } from '../image-engine/webglRenderer';
import { extractExifSegment, injectExif, normalizeExifSegment, parseExif, type ExifInfo } from '../metadata/exif';
import { buildExifSegment } from '../metadata/exifWriter';
import { applySpots } from '../retouch/apply';
import { readPixels } from '../retouch/source';
import { sharpenInPlace } from './sharpen';
import { FORMAT_INFO, MAX_EXPORT_PIXELS, SHARPEN_AMOUNT, resolveSize, sharpenSigma, type ExportSettings } from './types';

export interface ExportJob { original: Blob; name: string; type: string; params: EditParams; settings: ExportSettings }
export interface ExportResult { bytes: Uint8Array; mime: string; ext: string; width: number; height: number; notes: string[] }
export type ExportStage = 'Decoding' | 'Retouching' | 'Rendering' | 'Sharpening' | 'Encoding';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
const makeCanvas = (w: number, h: number): AnyCanvas => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

async function encode(canvas: AnyCanvas, mime: string, quality: number): Promise<Blob> {
  const q = quality / 100;
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: mime, quality: q });
  return new Promise((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('The browser could not encode the image.'))), mime, q));
}

function metadataFor(job: ExportJob, head: Uint8Array): Uint8Array | null {
  const m = job.settings.metadata;
  const overrides = !!(m.copyright.trim() || m.artist.trim());
  if (m.mode === 'none' && !overrides) return null;
  const seg = extractExifSegment(head);
  if (m.mode === 'original' && !overrides) return seg ? normalizeExifSegment(seg, { stripGps: m.removeLocation }) : null;
  // "basic", or a copyright/creator notice: write a fresh block from the fields we understand
  const src: ExifInfo = (m.mode === 'none' ? null : parseExif(head)) ?? {};
  const info: ExifInfo = { ...src, software: 'Roomlight' };
  if (m.copyright.trim()) info.copyright = m.copyright.trim();
  if (m.artist.trim()) info.artist = m.artist.trim();
  return buildExifSegment(info, { includeGps: !m.removeLocation });
}

export async function renderExport(job: ExportJob, progress: (s: ExportStage) => void = () => undefined): Promise<ExportResult> {
  const { settings, params } = job;
  const notes: string[] = [];
  const fmt = FORMAT_INFO[settings.format];

  progress('Decoding');
  let bitmap = await createImageBitmap(job.original, { imageOrientation: 'from-image' });
  const glCanvas = makeCanvas(1, 1);
  const gl = new WebGLRenderer(glCanvas as HTMLCanvasElement | OffscreenCanvas);
  try {
    const maxSide = gl.maxSize;
    if (Math.max(bitmap.width, bitmap.height) > maxSide) {
      const k = maxSide / Math.max(bitmap.width, bitmap.height);
      const scaled = await createImageBitmap(bitmap, { resizeWidth: Math.floor(bitmap.width * k), resizeHeight: Math.floor(bitmap.height * k), resizeQuality: 'high' });
      notes.push(`This GPU's texture limit is ${maxSide}px, so the ${bitmap.width}×${bitmap.height} original was reduced to ${scaled.width}×${scaled.height} before editing.`);
      bitmap.close(); bitmap = scaled;
    }

    if (params.spots.some((s) => s.enabled)) {
      progress('Retouching');
      const px = readPixels(bitmap);
      const r = applySpots(px.data, px.width, px.height, params.spots);
      gl.setImage(r.changed ? new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height) : bitmap);
    } else gl.setImage(bitmap);

    progress('Rendering');
    const native = outputSize(params, bitmap.width, bitmap.height);
    let { w, h } = resolveSize(native, settings.resize);
    if (Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w = Math.floor(w * k); h = Math.floor(h * k); notes.push(`The output was limited to ${maxSide}px on its long edge (GPU limit).`); }
    if (w * h > MAX_EXPORT_PIXELS) { const k = Math.sqrt(MAX_EXPORT_PIXELS / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); notes.push(`The output was limited to ${Math.round(MAX_EXPORT_PIXELS / 1e6)} megapixels.`); }
    const rb = gl.readbackSize(params, w, h);

    // GL rows are bottom-first and premultiplied; make them top-first, straight alpha.
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = src + x * 4, o = dst + x * 4, a = rb.data[i + 3];
        if (a === 255) { rgba[o] = rb.data[i]; rgba[o + 1] = rb.data[i + 1]; rgba[o + 2] = rb.data[i + 2]; rgba[o + 3] = 255; }
        else if (a > 0) { rgba[o] = Math.min(255, Math.round((rb.data[i] * 255) / a)); rgba[o + 1] = Math.min(255, Math.round((rb.data[i + 1] * 255) / a)); rgba[o + 2] = Math.min(255, Math.round((rb.data[i + 2] * 255) / a)); rgba[o + 3] = a; }
      }
    }

    const amount = SHARPEN_AMOUNT[settings.sharpen];
    if (amount > 0) { progress('Sharpening'); sharpenInPlace(rgba, w, h, amount, sharpenSigma(Math.max(w, h))); }

    if (settings.format === 'jpeg') { // no transparency in JPEG: composite over the chosen background
      const bg = [1, 3, 5].map((i) => parseInt(settings.background.slice(i, i + 2), 16));
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        if (a === 255) continue;
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((rgba[i + c] * a + bg[c] * (255 - a)) / 255);
        rgba[i + 3] = 255;
      }
    }

    progress('Encoding');
    const out = makeCanvas(w, h);
    (out.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    const blob = await encode(out, fmt.mime, settings.quality);
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    let mime = fmt.mime, ext = fmt.ext;
    if (blob.type && blob.type !== fmt.mime) { // e.g. Safari cannot encode WebP and silently writes PNG
      notes.push(`This browser cannot encode ${fmt.label}; a ${blob.type.replace('image/', '').toUpperCase()} file was written instead.`);
      mime = blob.type; ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : ext;
    }

    if (mime === 'image/jpeg') {
      const head = new Uint8Array(await job.original.slice(0, 512 * 1024).arrayBuffer());
      const isJpeg = job.type === 'image/jpeg' || /\.jpe?g$/i.test(job.name);
      const seg = metadataFor(job, isJpeg ? head : new Uint8Array());
      if (seg) bytes = injectExif(bytes, seg);
      else if (settings.metadata.mode !== 'none' && !isJpeg) notes.push('The source file has no EXIF metadata to carry over (only JPEG metadata is read).');
    } else if (settings.metadata.mode !== 'none' || settings.metadata.copyright.trim() || settings.metadata.artist.trim()) {
      notes.push('Metadata is only embedded in JPEG exports.');
    }
    return { bytes, mime, ext, width: w, height: h, notes };
  } finally {
    gl.dispose();
    bitmap.close();
  }
}
