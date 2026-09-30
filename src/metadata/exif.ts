/**
 * Minimal, dependency-free EXIF reader and editor for JPEG (Phase 6/7).
 *
 * Reads the handful of tags a photographer cares about (camera, lens, exposure, date, GPS,
 * copyright). Anything it cannot parse yields null — never invented values. For export it can
 * carry the original EXIF block into a JPEG written by the browser (which strips metadata),
 * resetting Orientation (the pixels are already upright) and optionally removing GPS.
 *
 * File structure: JPEG = SOI, then segments (0xFF marker, 2-byte big-endian length). EXIF lives
 * in an APP1 segment starting "Exif\0\0", followed by a TIFF block: byte-order mark, 0x002A,
 * offset of IFD0. An IFD = u16 entry count, 12-byte entries (tag u16, type u16, count u32,
 * value-or-offset u32), then a u32 pointer to the next IFD.
 */

export interface ExifInfo {
  make?: string;
  model?: string;
  lens?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  focalLength?: number; // mm
  focalLength35?: number; // mm, 35mm equivalent
  fNumber?: number;
  exposureTime?: number; // seconds
  iso?: number;
  exposureBias?: number; // EV
  capturedAt?: number; // ms since epoch (camera clock, read as local time)
  orientation?: number; // 1..8
  gps?: { lat: number; lon: number };
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Tiff { view: DataView; bytes: Uint8Array; le: boolean; base: number } // base = offset of the TIFF header in `bytes`
interface Entry { tag: number; type: number; count: number; valueOffset: number; entryOffset: number } // valueOffset = absolute offset of the value bytes

/** Locate the APP1 EXIF segment: offsets of the whole segment (incl. marker) and of its TIFF block. */
export function findExifSegment(b: Uint8Array): { start: number; end: number; tiff: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before pixels
    if (marker === 0xff) { i++; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (marker === 0xe1 && len >= 14 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
      return { start: i, end: Math.min(b.length, i + 2 + len), tiff: i + 10 };
    }
    i += 2 + len;
  }
  return null;
}

function openTiff(b: Uint8Array, base: number): Tiff | null {
  if (base + 8 > b.length) return null;
  const le = b[base] === 0x49 && b[base + 1] === 0x49;
  if (!le && !(b[base] === 0x4d && b[base + 1] === 0x4d)) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint16(base + 2, le) !== 0x002a) return null;
  return { view, bytes: b, le, base };
}

function readIfd(t: Tiff, ifdOffset: number): Entry[] {
  const start = t.base + ifdOffset;
  if (ifdOffset < 8 || start + 2 > t.bytes.length) return [];
  const n = t.view.getUint16(start, t.le);
  const out: Entry[] = [];
  for (let k = 0; k < n; k++) {
    const e = start + 2 + k * 12;
    if (e + 12 > t.bytes.length) break;
    const type = t.view.getUint16(e + 2, t.le), count = t.view.getUint32(e + 4, t.le);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueOffset = size <= 4 ? e + 8 : t.base + t.view.getUint32(e + 8, t.le);
    if (valueOffset + size > t.bytes.length) continue;
    out.push({ tag: t.view.getUint16(e, t.le), type, count, valueOffset, entryOffset: e });
  }
  return out;
}

const num = (t: Tiff, e: Entry, i = 0): number | undefined => {
  const o = e.valueOffset + i * (TYPE_SIZE[e.type] ?? 1);
  switch (e.type) {
    case 1: case 7: return t.bytes[o];
    case 3: return t.view.getUint16(o, t.le);
    case 4: return t.view.getUint32(o, t.le);
    case 8: return t.view.getInt16(o, t.le);
    case 9: return t.view.getInt32(o, t.le);
    case 5: { const d = t.view.getUint32(o + 4, t.le); return d ? t.view.getUint32(o, t.le) / d : undefined; }
    case 10: { const d = t.view.getInt32(o + 4, t.le); return d ? t.view.getInt32(o, t.le) / d : undefined; }
  }
  return undefined;
};
const str = (t: Tiff, e: Entry): string | undefined => {
  if (e.type !== 2 && e.type !== 7) return undefined;
  let s = '';
  for (let i = 0; i < e.count; i++) { const c = t.bytes[e.valueOffset + i]; if (c === 0) break; s += String.fromCharCode(c); }
  s = s.trim();
  return s || undefined;
};
const find = (es: Entry[], tag: number) => es.find((e) => e.tag === tag);

function parseDate(s: string | undefined): number | undefined {
  const m = s && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** Read EXIF from JPEG bytes. null when there is none (or it is unreadable). */
export function parseExif(b: Uint8Array): ExifInfo | null {
  const seg = findExifSegment(b);
  if (!seg) return null;
  const t = openTiff(b, seg.tiff);
  if (!t) return null;
  try {
    const ifd0 = readIfd(t, t.view.getUint32(t.base + 4, t.le));
    const exifPtr = find(ifd0, 0x8769), gpsPtr = find(ifd0, 0x8825);
    const ex = exifPtr ? readIfd(t, num(t, exifPtr) ?? 0) : [];
    const info: ExifInfo = {};
    const set = <K extends keyof ExifInfo>(k: K, v: ExifInfo[K] | undefined) => { if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) info[k] = v; };
    const s0 = (tag: number) => { const e = find(ifd0, tag); return e ? str(t, e) : undefined; };
    set('make', s0(0x010f)); set('model', s0(0x0110)); set('software', s0(0x0131)); set('artist', s0(0x013b)); set('copyright', s0(0x8298));
    const o = find(ifd0, 0x0112); if (o) set('orientation', num(t, o));
    const fe = (tag: number) => find(ex, tag);
    const ft = fe(0x829a); if (ft) set('exposureTime', num(t, ft));
    const fn = fe(0x829d); if (fn) set('fNumber', num(t, fn));
    const iso = fe(0x8827); if (iso) set('iso', num(t, iso));
    const fl = fe(0x920a); if (fl) set('focalLength', num(t, fl));
    const f35 = fe(0xa405); if (f35) set('focalLength35', num(t, f35));
    const eb = fe(0x9204); if (eb) set('exposureBias', num(t, eb));
    const lens = fe(0xa434); if (lens) set('lens', str(t, lens));
    const dt = fe(0x9003) ?? find(ifd0, 0x0132); if (dt) set('capturedAt', parseDate(str(t, dt)));
    if (gpsPtr) {
      const gps = readIfd(t, num(t, gpsPtr) ?? 0);
      const latRef = find(gps, 1), lat = find(gps, 2), lonRef = find(gps, 3), lon = find(gps, 4);
      if (latRef && lat && lonRef && lon && lat.count >= 3 && lon.count >= 3) {
        const dms = (e: Entry) => (num(t, e, 0) ?? NaN) + (num(t, e, 1) ?? NaN) / 60 + (num(t, e, 2) ?? NaN) / 3600;
        const la = dms(lat) * (str(t, latRef) === 'S' ? -1 : 1), lo = dms(lon) * (str(t, lonRef) === 'W' ? -1 : 1);
        if (Number.isFinite(la) && Number.isFinite(lo)) info.gps = { lat: la, lon: lo };
      }
    }
    return Object.keys(info).length ? info : null;
  } catch {
    return null;
  }
}

/** The raw APP1 EXIF segment (marker included) of a JPEG, or null. */
export function extractExifSegment(b: Uint8Array): Uint8Array | null {
  const seg = findExifSegment(b);
  return seg ? b.slice(seg.start, seg.end) : null;
}

/** Copy of an APP1 EXIF segment with Orientation set to 1 (the pixels were already rotated on import). */
export function normalizeExifSegment(seg: Uint8Array, opts: { stripGps?: boolean } = {}): Uint8Array {
  let b = new Uint8Array(seg);
  const t = openTiff(b, 10);
  if (!t) return b;
  const ifd0Off = t.view.getUint32(t.base + 4, t.le);
  const ifd0 = readIfd(t, ifd0Off);
  const o = find(ifd0, 0x0112);
  if (o && o.type === 3) t.view.setUint16(o.valueOffset, 1, t.le);
  const gps = find(ifd0, 0x8825);
  if (opts.stripGps && gps) {
    // zero the GPS IFD and the out-of-line values it points at, then delete the pointer entry from IFD0
    const goff = num(t, gps) ?? 0, gstart = t.base + goff;
    if (goff >= 8 && gstart + 2 <= b.length) {
      const n = t.view.getUint16(gstart, t.le);
      for (const e of readIfd(t, goff)) {
        const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
        if (size > 4) b.fill(0, e.valueOffset, e.valueOffset + size);
      }
      b.fill(0, gstart, Math.min(b.length, gstart + 2 + n * 12 + 4));
    }
    const start = t.base + ifd0Off, n0 = t.view.getUint16(start, t.le);
    const idx = (gps.entryOffset - (start + 2)) / 12;
    const tail = start + 2 + (idx + 1) * 12, end = start + 2 + n0 * 12 + 4;
    b.copyWithin(start + 2 + idx * 12, tail, end);
    b.fill(0, end - 12, end);
    t.view.setUint16(start, n0 - 1, t.le);
  }
  return b;
}

/** Insert an APP1 EXIF segment into JPEG bytes (after SOI and any JFIF APP0). Existing EXIF is replaced. */
export function injectExif(jpeg: Uint8Array, exifSegment: Uint8Array): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const old = findExifSegment(jpeg);
  const base = old ? new Uint8Array([...jpeg.subarray(0, old.start), ...jpeg.subarray(old.end)]) : jpeg;
  let at = 2;
  if (base[2] === 0xff && base[3] === 0xe0) at = 4 + ((base[4] << 8) | base[5]); // keep JFIF first
  const out = new Uint8Array(base.length + exifSegment.length);
  out.set(base.subarray(0, at), 0);
  out.set(exifSegment, at);
  out.set(base.subarray(at), at + exifSegment.length);
  return out;
}

/** "1/250 s", "f/2.8", "ISO 400", "35 mm" ... human-readable summaries for the Info panel. */
export function formatExposure(s: number): string { return s >= 1 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)} s`; }
