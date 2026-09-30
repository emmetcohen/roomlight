import { parseExif, type ExifInfo } from './exif';

/** EXIF of an imported file. Only JPEG carries EXIF we can read; everything else is null (nothing invented). */
export async function readExif(blob: Blob, type: string, name: string): Promise<ExifInfo | null> {
  if (type !== 'image/jpeg' && !/\.jpe?g$/i.test(name)) return null;
  try {
    return parseExif(new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer()));
  } catch {
    return null;
  }
}
