/**
 * Builds a fresh EXIF APP1 segment from the fields Roomlight understands (see exif.ts).
 * Used on export when the user wants a copyright / creator notice, or "basic" metadata only.
 * Little-endian TIFF: IFD0 → Exif IFD → GPS IFD, with out-of-line values after the IFDs.
 */
import type { ExifInfo } from './exif';

interface Ent { tag: number; type: number; count: number; data: number[] }

const ascii = (s: string): Ent['data'] => [...new TextEncoder().encode(s.replace(/[^\x20-\x7e]/g, '?')), 0];
const u16 = (v: number) => [v & 255, (v >> 8) & 255];
const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const rational = (n: number, d: number) => [...u32(n >>> 0), ...u32(d >>> 0)];
const srational = (n: number, d: number) => [...u32(n | 0), ...u32(d >>> 0)];
const toRat = (x: number): [number, number] => { const d = x >= 1000 ? 1 : x >= 10 ? 100 : 10000; return [Math.round(x * d), d]; };
const pad2 = (n: number) => String(n).padStart(2, '0');
export const exifDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

function dms(x: number): number[] {
  const a = Math.abs(x), deg = Math.floor(a), minF = (a - deg) * 60, min = Math.floor(minF), sec = (minF - min) * 60;
  return [...rational(deg, 1), ...rational(min, 1), ...rational(Math.round(sec * 10000), 10000)];
}

/** Size in bytes of an IFD's table (count + entries + next pointer). */
const tableSize = (n: number) => 2 + n * 12 + 4;

export function buildExifSegment(info: ExifInfo, opts: { includeGps?: boolean } = {}): Uint8Array {
  const ifd0: Ent[] = [], exif: Ent[] = [], gps: Ent[] = [];
  const A = (list: Ent[], tag: number, v?: string) => { if (v) list.push({ tag, type: 2, count: ascii(v).length, data: ascii(v) }); };
  A(ifd0, 0x010f, info.make); A(ifd0, 0x0110, info.model);
  ifd0.push({ tag: 0x0112, type: 3, count: 1, data: u16(1) }); // pixels are already upright
  A(ifd0, 0x0131, info.software);
  if (info.capturedAt !== undefined) A(ifd0, 0x0132, exifDate(info.capturedAt));
  A(ifd0, 0x013b, info.artist); A(ifd0, 0x8298, info.copyright);

  if (info.exposureTime) exif.push({ tag: 0x829a, type: 5, count: 1, data: info.exposureTime < 1 ? rational(1, Math.round(1 / info.exposureTime)) : rational(Math.round(info.exposureTime * 100), 100) });
  if (info.fNumber) exif.push({ tag: 0x829d, type: 5, count: 1, data: rational(...toRat(info.fNumber)) });
  if (info.iso) exif.push({ tag: 0x8827, type: 3, count: 1, data: u16(Math.min(65535, Math.round(info.iso))) });
  if (info.capturedAt !== undefined) A(exif, 0x9003, exifDate(info.capturedAt));
  if (info.exposureBias !== undefined) exif.push({ tag: 0x9204, type: 10, count: 1, data: srational(Math.round(info.exposureBias * 1000), 1000) });
  if (info.focalLength) exif.push({ tag: 0x920a, type: 5, count: 1, data: rational(...toRat(info.focalLength)) });
  if (info.focalLength35) exif.push({ tag: 0xa405, type: 3, count: 1, data: u16(Math.round(info.focalLength35)) });
  A(exif, 0xa434, info.lens);

  const withGps = !!(opts.includeGps && info.gps);
  if (withGps) {
    const { lat, lon } = info.gps!;
    A(gps, 1, lat < 0 ? 'S' : 'N'); gps.push({ tag: 2, type: 5, count: 3, data: dms(lat) });
    A(gps, 3, lon < 0 ? 'W' : 'E'); gps.push({ tag: 4, type: 5, count: 3, data: dms(lon) });
  }

  // pointer entries (values patched once offsets are known)
  const ptrExif: Ent | null = exif.length ? { tag: 0x8769, type: 4, count: 1, data: u32(0) } : null;
  const ptrGps: Ent | null = withGps ? { tag: 0x8825, type: 4, count: 1, data: u32(0) } : null;
  if (ptrExif) ifd0.push(ptrExif);
  if (ptrGps) ifd0.push(ptrGps);
  ifd0.sort((a, b) => a.tag - b.tag);

  const lists = [ifd0, ...(exif.length ? [exif] : []), ...(withGps ? [gps] : [])];
  const tableStart: number[] = [];
  let off = 8;
  for (const l of lists) { tableStart.push(off); off += tableSize(l.length); }
  const place = new Map<Ent, number>();
  for (const l of lists) for (const e of l) if (e.data.length > 4) { place.set(e, off); off += e.data.length + (e.data.length & 1); }
  if (ptrExif) ptrExif.data = u32(tableStart[1]);
  if (ptrGps) ptrGps.data = u32(tableStart[lists.indexOf(gps)]);

  const tiff = new Uint8Array(off);
  tiff.set([0x49, 0x49, 0x2a, 0x00, ...u32(8)], 0);
  lists.forEach((l, li) => {
    let p = tableStart[li];
    tiff.set(u16(l.length), p); p += 2;
    for (const e of l) {
      tiff.set([...u16(e.tag), ...u16(e.type), ...u32(e.count)], p);
      if (e.data.length <= 4) tiff.set(e.data, p + 8); else { tiff.set(u32(place.get(e)!), p + 8); tiff.set(e.data, place.get(e)!); }
      p += 12;
    }
  });
  const len = 2 + 6 + tiff.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, 0xe1, (len >> 8) & 255, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  seg.set(tiff, 10);
  return seg;
}
