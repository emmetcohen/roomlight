import { describe, expect, it } from 'vitest';
import { extractExifSegment, findExifSegment, formatExposure, injectExif, normalizeExifSegment, parseExif, type ExifInfo } from '../src/metadata/exif';
import { buildExifSegment } from '../src/metadata/exifWriter';

const INFO: ExifInfo = {
  make: 'ACME', model: 'Model One', lens: '35mm F1.8 (test)', software: 'Roomlight', artist: 'A. Photographer', copyright: '© 2026 A. Photographer'.replace('©', '(c)'),
  focalLength: 35, focalLength35: 52, fNumber: 1.8, exposureTime: 1 / 250, iso: 400, exposureBias: -0.7,
  capturedAt: new Date(2025, 5, 14, 9, 30, 15).getTime(), gps: { lat: 48.8584, lon: -2.2945 },
};

/** SOI + JFIF APP0 + (optional extra segment) + a fake scan. */
function jpeg(exif?: Uint8Array): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...(exif ?? []), 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
}
const close = (a: number | undefined, b: number, tol = 1e-3) => expect(Math.abs((a ?? NaN) - b)).toBeLessThan(tol);

describe('EXIF reader/writer', () => {
  it('round-trips every field it writes', () => {
    const got = parseExif(jpeg(buildExifSegment(INFO, { includeGps: true })))!;
    expect(got).toMatchObject({ make: 'ACME', model: 'Model One', lens: '35mm F1.8 (test)', software: 'Roomlight', artist: 'A. Photographer', iso: 400, orientation: 1, capturedAt: INFO.capturedAt });
    expect(got.copyright).toBe(INFO.copyright);
    close(got.focalLength, 35); close(got.focalLength35, 52); close(got.fNumber, 1.8); close(got.exposureTime, 1 / 250, 1e-6); close(got.exposureBias, -0.7);
    close(got.gps?.lat, 48.8584, 1e-4); close(got.gps?.lon, -2.2945, 1e-4);
  });

  it('writes no GPS unless asked', () => {
    expect(parseExif(jpeg(buildExifSegment(INFO)))!.gps).toBeUndefined();
  });

  it('returns null (never invented values) for files without EXIF or with junk', () => {
    expect(parseExif(jpeg())).toBeNull();
    expect(parseExif(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseExif(new Uint8Array())).toBeNull();
    expect(parseExif(jpeg(buildExifSegment({})))).toMatchObject({ orientation: 1 }); // only the orientation we always write
  });

  it('never throws on corrupted input', () => {
    const good = jpeg(buildExifSegment(INFO, { includeGps: true }));
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 400; n++) {
      const b = new Uint8Array(good);
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
      expect(() => parseExif(cut)).not.toThrow();
    }
  });

  it('carries the original EXIF into another JPEG, after the JFIF segment, replacing any existing block', () => {
    const src = jpeg(buildExifSegment(INFO, { includeGps: true }));
    const seg = extractExifSegment(src)!;
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xda, 0x00, 0x02, 9, 0xff, 0xd9]);
    const out = injectExif(bare, seg);
    expect(parseExif(out)!.model).toBe('Model One');
    expect(out[2]).toBe(0xff); expect(out[3]).toBe(0xe0); // JFIF still first
    expect(findExifSegment(out)!.start).toBe(20);
    expect(out.length).toBe(bare.length + seg.length);
    // injecting again does not duplicate
    const twice = injectExif(out, buildExifSegment({ model: 'Other' }));
    expect(parseExif(twice)!.model).toBe('Other');
    expect(twice.length).toBe(bare.length + buildExifSegment({ model: 'Other' }).length);
  });

  it('resets Orientation to 1 and can strip GPS while keeping everything else', () => {
    const seg = buildExifSegment({ focalLength: 35, iso: 100 }, { includeGps: false });
    // the first IFD0 entry is Orientation (tag 0x0112): turn it into 6 (rotate 90° CW) as a camera would
    seg[10 + 8 + 2 + 8] = 6;
    expect(parseExif(jpeg(seg))!.orientation).toBe(6);
    expect(parseExif(jpeg(normalizeExifSegment(seg)))!.orientation).toBe(1);

    const withGps = buildExifSegment(INFO, { includeGps: true });
    const stripped = normalizeExifSegment(withGps, { stripGps: true });
    const got = parseExif(jpeg(stripped))!;
    expect(got.gps).toBeUndefined();
    expect(got).toMatchObject({ make: 'ACME', model: 'Model One', iso: 400, lens: '35mm F1.8 (test)' });
    close(got.fNumber, 1.8);
    expect(parseExif(jpeg(normalizeExifSegment(withGps)))!.gps).toBeDefined(); // kept when not asked
    expect(stripped.length).toBe(withGps.length); // same size: nothing shifts
  });

  it('formats exposure times', () => {
    expect(formatExposure(1 / 250)).toBe('1/250 s');
    expect(formatExposure(2)).toBe('2 s');
    expect(formatExposure(0.5)).toBe('1/2 s');
  });
});
