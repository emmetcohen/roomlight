import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT, formatFilename, normalizeExport, resolveSize, sanitizeFilename, sharpenSigma, uniqueNames } from '../src/export/types';
import { sharpenInPlace } from '../src/export/sharpen';
import { crc32, zipStore } from '../src/export/zip';

describe('export settings', () => {
  it('normalizes garbage to safe defaults and clamps ranges', () => {
    expect(normalizeExport(undefined)).toEqual(DEFAULT_EXPORT);
    expect(normalizeExport('x')).toEqual(DEFAULT_EXPORT);
    const s = normalizeExport({ format: 'gif', quality: 500, resize: { mode: 'weird', longEdge: -4, percent: 9999 }, sharpen: 'max', background: 'red', metadata: { mode: 'x', copyright: 'c'.repeat(500) }, filename: '   ', zip: false });
    expect(s.format).toBe('jpeg'); expect(s.quality).toBe(100); expect(s.resize.mode).toBe('original'); expect(s.resize.longEdge).toBe(16); expect(s.resize.percent).toBe(400);
    expect(s.sharpen).toBe('off'); expect(s.background).toBe('#ffffff'); expect(s.metadata.mode).toBe('original'); expect(s.metadata.copyright).toHaveLength(200); expect(s.filename).toBe('{name}-edit'); expect(s.zip).toBe(false);
  });
  it('round-trips valid settings', () => {
    const s = { ...DEFAULT_EXPORT, format: 'webp' as const, quality: 70, sharpen: 'high' as const, resize: { ...DEFAULT_EXPORT.resize, mode: 'longEdge' as const, longEdge: 1600 } };
    expect(normalizeExport(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('resolveSize', () => {
  const native = { w: 6000, h: 4000 };
  const R = (o: Partial<typeof DEFAULT_EXPORT.resize>) => ({ ...DEFAULT_EXPORT.resize, ...o });
  it('original keeps the native size', () => expect(resolveSize(native, R({ mode: 'original' }))).toEqual(native));
  it('long edge scales the longer side, keeping the aspect', () => { expect(resolveSize(native, R({ mode: 'longEdge', longEdge: 1500 }))).toEqual({ w: 1500, h: 1000 }); expect(resolveSize({ w: 4000, h: 6000 }, R({ mode: 'longEdge', longEdge: 1500 }))).toEqual({ w: 1000, h: 1500 }); });
  it('fit keeps the picture inside the box', () => { expect(resolveSize(native, R({ mode: 'fit', width: 1200, height: 1200 }))).toEqual({ w: 1200, h: 800 }); expect(resolveSize(native, R({ mode: 'fit', width: 3000, height: 500 }))).toEqual({ w: 750, h: 500 }); });
  it('percent scales both sides', () => expect(resolveSize(native, R({ mode: 'percent', percent: 25 }))).toEqual({ w: 1500, h: 1000 }));
  it('"don\'t enlarge" caps at the native size; turning it off allows upscaling', () => {
    expect(resolveSize(native, R({ mode: 'longEdge', longEdge: 9000, noEnlarge: true }))).toEqual(native);
    expect(resolveSize(native, R({ mode: 'longEdge', longEdge: 9000, noEnlarge: false }))).toEqual({ w: 9000, h: 6000 });
  });
  it('never returns less than 1 px', () => expect(resolveSize({ w: 10, h: 10 }, R({ mode: 'percent', percent: 1 }))).toEqual({ w: 1, h: 1 }));
});

describe('file names', () => {
  const ctx = { name: 'IMG_0042.JPG', index: 7, total: 20, date: new Date(2025, 5, 4), rating: 4, title: 'Harbour', width: 1600, height: 900 };
  it('fills every token', () => {
    expect(formatFilename('{name}-edit', ctx)).toBe('IMG_0042-edit');
    expect(formatFilename('{date}_{nnn}_{rating}star_{w}x{h}', ctx)).toBe('2025-06-04_007_4star_1600x900');
    expect(formatFilename('{title}', ctx)).toBe('Harbour'); expect(formatFilename('{title}', { ...ctx, title: '' })).toBe('IMG_0042');
    expect(formatFilename('{n}/{nn}', ctx)).toBe('7-07');
  });
  it('sanitizes characters that are illegal in file names', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFilename('  ..  ')).toBe('photo'); expect(sanitizeFilename('')).toBe('photo'); expect(sanitizeFilename('x'.repeat(300))).toHaveLength(120);
  });
  it('makes batch names unique, case-insensitively', () => expect(uniqueNames(['a', 'B', 'A', 'a', 'b'])).toEqual(['a', 'B', 'A-2', 'a-3', 'b-2']));
});

describe('output sharpening', () => {
  const img = (w: number, h: number, fn: (x: number, y: number) => number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4); return d; };
  const edge = () => img(40, 8, (x) => (x < 20 ? [80, 80, 80, 255] : [170, 170, 170, 255]));
  it('amount 0 and flat images are unchanged', () => {
    const a = edge(), b = new Uint8ClampedArray(a); sharpenInPlace(b, 40, 8, 0, 1); expect(Array.from(b)).toEqual(Array.from(a));
    const flat = img(16, 16, () => [120, 60, 30, 255]), f2 = new Uint8ClampedArray(flat); sharpenInPlace(f2, 16, 16, 100, 1.2); expect(Array.from(f2)).toEqual(Array.from(flat));
  });
  it('steepens an edge: overshoot on both sides, flat areas far from it untouched', () => {
    const d = edge(); sharpenInPlace(d, 40, 8, 100, 1.2);
    expect(d[(4 * 40 + 19) * 4]).toBeLessThan(80); expect(d[(4 * 40 + 20) * 4]).toBeGreaterThan(170);
    expect(d[(4 * 40 + 2) * 4]).toBe(80); expect(d[(4 * 40 + 37) * 4]).toBe(170);
  });
  it('more amount means a stronger effect', () => {
    const lo = edge(), hi = edge(); sharpenInPlace(lo, 40, 8, 30, 1.2); sharpenInPlace(hi, 40, 8, 100, 1.2);
    expect(hi[(4 * 40 + 20) * 4]).toBeGreaterThan(lo[(4 * 40 + 20) * 4]);
  });
  it('keeps grey grey and leaves alpha alone', () => {
    const d = img(40, 8, (x) => (x < 20 ? [80, 80, 80, 200] : [170, 170, 170, 90])); sharpenInPlace(d, 40, 8, 100, 1.2);
    for (let i = 0; i < 40 * 8; i++) { expect(d[i * 4]).toBe(d[i * 4 + 1]); expect(d[i * 4 + 1]).toBe(d[i * 4 + 2]); }
    expect(d[3]).toBe(200); expect(d[(20) * 4 + 3]).toBe(90);
  });
  it('does not shift colour (luma-only): hue ratios survive on a coloured edge', () => {
    const d = img(40, 8, (x) => (x < 20 ? [200, 60, 60, 255] : [60, 60, 200, 255])); const before = new Uint8ClampedArray(d); sharpenInPlace(d, 40, 8, 60, 1);
    const dr = d[(4 * 40 + 19) * 4] - before[(4 * 40 + 19) * 4], dg = d[(4 * 40 + 19) * 4 + 1] - before[(4 * 40 + 19) * 4 + 1], db = d[(4 * 40 + 19) * 4 + 2] - before[(4 * 40 + 19) * 4 + 2];
    expect(Math.abs(dr - dg)).toBeLessThanOrEqual(1); expect(Math.abs(dg - db)).toBeLessThanOrEqual(1); // same delta on every channel
  });
  it('σ grows with the output size within bounds', () => { expect(sharpenSigma(500)).toBe(0.6); expect(sharpenSigma(3000)).toBe(1); expect(sharpenSigma(20000)).toBe(1.8); });
});

describe('ZIP writer', () => {
  it('CRC-32 matches the standard check value', () => expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926));

  /** Minimal reader: end record -> central directory -> local headers. */
  function readZip(z: Uint8Array) {
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const eocd = z.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
    const out: { name: string; data: Uint8Array; crc: number }[] = [];
    for (let i = 0; i < count; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), size = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nl));
      expect(method).toBe(0);
      expect(v.getUint32(off, true)).toBe(0x04034b50);
      const lnl = v.getUint16(off + 26, true), lel = v.getUint16(off + 28, true);
      const data = z.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + size);
      out.push({ name, data, crc });
      p += 46 + nl + el + cl;
    }
    return out;
  }
  it('writes a readable archive: names (incl. UTF-8), bytes and CRCs survive', () => {
    const a = new Uint8Array([1, 2, 3, 250, 0, 7]), b = new TextEncoder().encode('héllo wörld'), c = new Uint8Array(0);
    const entries = readZip(zipStore([{ name: 'a.jpg', data: a }, { name: 'Ünï/b.txt', data: b }, { name: 'empty.bin', data: c }]));
    expect(entries.map((e) => e.name)).toEqual(['a.jpg', 'Ünï/b.txt', 'empty.bin']);
    expect(Array.from(entries[0].data)).toEqual(Array.from(a)); expect(new TextDecoder().decode(entries[1].data)).toBe('héllo wörld'); expect(entries[2].data.length).toBe(0);
    for (const e of entries) expect(crc32(e.data)).toBe(e.crc);
  });
  it('handles many files', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.bin`, data: new Uint8Array([i & 255, (i >> 8) & 255]) }));
    const r = readZip(zipStore(files)); expect(r).toHaveLength(300); expect(Array.from(r[299].data)).toEqual([299 & 255, 1]);
  });
  it('an empty archive is valid', () => expect(readZip(zipStore([]))).toEqual([]));
});
