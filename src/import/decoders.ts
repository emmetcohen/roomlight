/**
 * Decoder registry. Import is deliberately separated from editing: a decoder turns a file
 * into an ImageBitmap (8-bit sRGB) plus dimensions. Anything the registry cannot decode is
 * rejected with an explicit message — a RAW file is never passed off as a JPEG.
 *
 * Adding RAW support later means implementing `ImageDecoder` (e.g. wrapping a WASM LibRaw
 * build that demosaics to linear float) and registering it ahead of the browser decoder.
 */

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number; // pixel size of the *original* image
  height: number;
}

export interface ImageDecoder {
  id: string;
  label: string;
  canDecode(file: File): boolean;
  decode(file: Blob, maxDim: number): Promise<DecodedImage>;
}

export class UnsupportedFormatError extends Error {}

export const RAW_EXTENSIONS = ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'srf', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', '3fr', 'erf', 'kdc', 'mrw', 'x3f'];

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Decodes whatever the browser's native image decoder supports (JPEG, PNG, WebP, ...). */
export const browserDecoder: ImageDecoder = {
  id: 'browser',
  label: 'Browser image decoder (JPEG, PNG, WebP)',
  canDecode(file) {
    const ext = extensionOf(file.name);
    return /^image\/(jpeg|png|webp|avif|gif|bmp)$/.test(file.type) || ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'].includes(ext);
  },
  async decode(file, maxDim) {
    // 'from-image' applies EXIF orientation; default colour conversion maps embedded profiles to sRGB.
    const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = full;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    if (scale === 1) return { bitmap: full, width, height };
    const bitmap = await createImageBitmap(full, {
      resizeWidth: Math.round(width * scale),
      resizeHeight: Math.round(height * scale),
      resizeQuality: 'high',
    });
    full.close();
    return { bitmap, width, height };
  },
};

const decoders: ImageDecoder[] = [browserDecoder];

export function registerDecoder(d: ImageDecoder): void {
  decoders.unshift(d);
}

export function findDecoder(file: File): ImageDecoder {
  const d = decoders.find((x) => x.canDecode(file));
  if (d) return d;
  const ext = extensionOf(file.name);
  if (RAW_EXTENSIONS.includes(ext)) {
    throw new UnsupportedFormatError(`${file.name}: camera RAW (.${ext}) needs a RAW decoder, and none is installed yet. Export a JPEG/PNG/WebP for now.`);
  }
  if (ext === 'heic' || ext === 'heif' || /heic|heif/.test(file.type)) {
    throw new UnsupportedFormatError(`${file.name}: HEIC/HEIF is not decodable in this browser.`);
  }
  if (ext === 'tif' || ext === 'tiff') {
    throw new UnsupportedFormatError(`${file.name}: TIFF decoding is not implemented yet.`);
  }
  throw new UnsupportedFormatError(`${file.name}: unsupported file type.`);
}

/** Decode, turning any browser decoding failure into a clear error. */
export async function decodeFile(file: File, maxDim: number): Promise<DecodedImage> {
  const d = findDecoder(file);
  try {
    return await d.decode(file, maxDim);
  } catch (e) {
    if (e instanceof UnsupportedFormatError) throw e;
    throw new UnsupportedFormatError(`${file.name}: could not be decoded (${d.label}). The file may be corrupt or use an unsupported codec.`);
  }
}
