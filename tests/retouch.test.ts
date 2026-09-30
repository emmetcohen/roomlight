import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, normalizeParams, paramsEqual } from '../src/image-engine/params';
import { applySpots } from '../src/retouch/apply';
import { normalizeSpots, newSpot, type Spot } from '../src/retouch/types';
import { px } from './helpers';

const W = 96, H = 96;

/** Smooth colour gradient with a little fine texture. */
function gradient(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, tex = Math.sin(x * 1.3) * Math.cos(y * 1.1) * 3;
    d[o] = 60 + x + tex; d[o + 1] = 80 + y * 0.8 + tex; d[o + 2] = 120 + tex; d[o + 3] = 255;
  }
  return d;
}
function withDot(base: Uint8ClampedArray, cx: number, cy: number, r: number, v = [15, 15, 15]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(base);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) { const o = (y * W + x) * 4; d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; }
  return d;
}
const L = Math.max(W, H);
const m = (x: number, y: number) => ({ x: (x - W / 2) / L, y: (y - H / 2) / L });
const spot = (kind: Spot['kind'], t: [number, number], s: [number, number], r: number, o: Partial<Spot> = {}): Spot => {
  const a = m(...t), b = m(...s);
  return { ...newSpot(kind, a.x, a.y, r / L, { sx: b.x, sy: b.y }, 0.4, 1), ...o };
};
const err = (a: Uint8ClampedArray, b: Uint8ClampedArray, cx: number, cy: number, r: number) => {
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) { const o = (y * W + x) * 4; for (let c = 0; c < 3; c++) { s += Math.abs(a[o + c] - b[o + c]); n++; } }
  return s / n;
};

describe('retouch: apply', () => {
  it('returns the very same array when there is nothing to do', () => {
    const src = gradient();
    expect(applySpots(src, W, H, []).data).toBe(src);
    expect(applySpots(src, W, H, [spot('clone', [30, 30], [60, 60], 6, { enabled: false })]).data).toBe(src);
    expect(applySpots(src, W, H, [spot('clone', [30, 30], [60, 60], 6, { opacity: 0 })]).data).toBe(src);
  });

  it('never modifies its input', () => {
    const src = withDot(gradient(), 48, 48, 4);
    const copy = new Uint8ClampedArray(src);
    const r = applySpots(src, W, H, [spot('heal', [48, 48], [70, 48], 8), spot('remove', [20, 20], [0, 0], 6)]);
    expect(r.changed).toBe(true);
    expect(r.data).not.toBe(src);
    expect(Array.from(src)).toEqual(Array.from(copy));
  });

  it('clone copies the source patch exactly (hard edge, full opacity)', () => {
    const src = gradient();
    const r = applySpots(src, W, H, [spot('clone', [30, 30], [66, 60], 6, { feather: 0 })]).data;
    // target centre now shows what was at the source centre
    expect(px(r, W, 30, 30)).toEqual(px(src, W, 66, 60));
    expect(px(r, W, 31, 29)).toEqual(px(src, W, 67, 59));
    // and nothing outside the circle changed
    expect(px(r, W, 30 + 9, 30)).toEqual(px(src, W, 39, 30));
    expect(px(r, W, 10, 80)).toEqual(px(src, W, 10, 80));
  });

  it('feather fades the patch out toward the edge; opacity scales it', () => {
    const src = gradient();
    const hard = applySpots(src, W, H, [spot('clone', [30, 30], [66, 60], 10, { feather: 0 })]).data;
    const soft = applySpots(src, W, H, [spot('clone', [30, 30], [66, 60], 10, { feather: 1 })]).data;
    const half = applySpots(src, W, H, [spot('clone', [30, 30], [66, 60], 10, { feather: 0, opacity: 0.5 })]).data;
    const at = (d: Uint8ClampedArray) => px(d, W, 37, 30)[0]; // 7 px from the centre
    const orig = px(src, W, 37, 30)[0], full = at(hard);
    expect(Math.abs(at(soft) - orig)).toBeLessThan(Math.abs(full - orig)); // nearer the edge → closer to the original
    const c = (d: Uint8ClampedArray) => px(d, W, 30, 30)[0];
    expect(c(half)).toBeGreaterThan(Math.min(c(src), c(hard)) - 1);
    expect(Math.abs(c(half) - (c(src) + c(hard)) / 2)).toBeLessThanOrEqual(3); // halfway, allowing for gamma
  });

  it('heal matches the surroundings; clone of the same source does not', () => {
    // a dark target area next to a bright source area
    const src = gradient();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x > 60) { const o = (y * W + x) * 4; src[o] = Math.min(255, src[o] + 90); src[o + 1] = Math.min(255, src[o + 1] + 60); }
    const target: [number, number] = [25, 50], source: [number, number] = [76, 50];
    const around = px(src, W, 25 + 11, 50); // just outside the spot
    const cloned = applySpots(src, W, H, [spot('clone', target, source, 8, { feather: 0 })]).data;
    const healed = applySpots(src, W, H, [spot('heal', target, source, 8, { feather: 0 })]).data;
    const inC = px(cloned, W, 25, 50), inH = px(healed, W, 25, 50);
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(inC, around)).toBeGreaterThan(60); // clone drags the bright colour in
    expect(dist(inH, around)).toBeLessThan(25); // heal adopts the local colour
    // the edge of the healed patch has no visible seam
    const edge = px(healed, W, 25 + 7, 50), out = px(healed, W, 25 + 9, 50);
    expect(dist(edge, out)).toBeLessThan(18);
  });

  it('heal keeps the source texture (it is not a flat fill)', () => {
    const src = gradient();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x > 60) { const o = (y * W + x) * 4; const v = ((x + y) % 4 < 2) ? 40 : -40; src[o] += v; src[o + 1] += v; src[o + 2] += v; }
    const healed = applySpots(src, W, H, [spot('heal', [25, 50], [76, 50], 9, { feather: 0 })]).data;
    const row = Array.from({ length: 10 }, (_, i) => px(healed, W, 21 + i, 50)[0]);
    const range = Math.max(...row) - Math.min(...row);
    expect(range).toBeGreaterThan(40); // the copied stripes survive
  });

  it('remove takes out a blemish using an automatically found source', () => {
    const clean = gradient();
    const dirty = withDot(clean, 48, 48, 4);
    const before = err(dirty, clean, 48, 48, 5);
    const r = applySpots(dirty, W, H, [spot('remove', [48, 48], [0, 0], 7, { feather: 0.5 })]);
    const after = err(r.data, clean, 48, 48, 5);
    expect(before).toBeGreaterThan(50);
    expect(after).toBeLessThan(before * 0.1);
    const res = r.resolved.values().next().value!;
    expect(res.ok).toBe(true);
    // the found source is well away from the target and not the dot itself
    expect(Math.hypot(res.sx - m(48, 48).x, res.sy - m(48, 48).y) * L).toBeGreaterThan(14);
  });

  it('remove prefers a clean source over one that contains another blemish', () => {
    const clean = gradient();
    // blemish at the target and a second one directly to the right (where a close candidate would land)
    const dirty = withDot(withDot(clean, 48, 48, 4), 48 + 7 * 2.3 / 1.0 * 0.5 + 14, 48, 4);
    const r = applySpots(dirty, W, H, [spot('remove', [48, 48], [0, 0], 7, { feather: 0.5 })]);
    expect(err(r.data, clean, 48, 48, 5)).toBeLessThan(10);
  });

  it('remove reports failure (and changes nothing) when no source patch fits in the picture', () => {
    const src = gradient();
    const r = applySpots(src, W, H, [spot('remove', [48, 48], [0, 0], 40)]);
    expect(r.changed).toBe(false);
    expect([...r.resolved.values()][0].ok).toBe(false);
  });

  it('spots apply in order (a later spot sees an earlier one)', () => {
    const src = gradient();
    const a = spot('clone', [20, 20], [60, 60], 6, { feather: 0 });
    const b = spot('clone', [20, 70], [20, 20], 6, { feather: 0 });
    const r = applySpots(src, W, H, [a, b]).data;
    expect(px(r, W, 20, 70)).toEqual(px(src, W, 60, 60)); // b copied what a had pasted
  });

  it('is deterministic', () => {
    const src = withDot(gradient(), 48, 48, 4);
    const s = [spot('remove', [48, 48], [0, 0], 7)];
    expect(Array.from(applySpots(src, W, H, s).data)).toEqual(Array.from(applySpots(src, W, H, s).data));
  });

  it('is resolution independent (mask-space coordinates)', () => {
    const small = withDot(gradient(), 48, 48, 4);
    const up = new Uint8ClampedArray(W * 2 * H * 2 * 4);
    for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) { const a = ((y >> 1) * W + (x >> 1)) * 4, o = (y * W * 2 + x) * 4; for (let c = 0; c < 4; c++) up[o + c] = small[a + c]; }
    const s = [spot('remove', [48, 48], [0, 0], 7)];
    const a = applySpots(small, W, H, s).data, b = applySpots(up, W * 2, H * 2, s).data;
    // centre pixel after removal is close to the clean gradient at both sizes
    const ca = px(a, W, 48, 48), cb = px(b, W * 2, 96, 96);
    expect(Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2])).toBeLessThan(12);
  });
});

describe('retouch: parameters', () => {
  it('normalizeSpots drops garbage and clamps values', () => {
    const out = normalizeSpots([
      { id: 'a', kind: 'clone', x: 0.1, y: -0.1, sx: 0.2, sy: 0.2, r: 5, feather: 9, opacity: -1, enabled: true },
      { id: 'b', kind: 'bogus', x: NaN },
      null, 'x', { kind: 'heal' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a', kind: 'clone', r: 0.25, feather: 1, opacity: 0 });
    expect(out[1]).toMatchObject({ id: 'b', kind: 'heal', x: 0 });
    expect(normalizeSpots(undefined)).toEqual([]);
  });

  it('spots are part of the edit (equality, persistence, defaults)', () => {
    const s = spot('heal', [30, 30], [60, 60], 6);
    const p = { ...DEFAULT_PARAMS, spots: [s] };
    expect(paramsEqual(p, DEFAULT_PARAMS)).toBe(false);
    expect(paramsEqual(p, { ...DEFAULT_PARAMS, spots: [{ ...s }] })).toBe(true);
    expect(normalizeParams(JSON.parse(JSON.stringify(p))).spots).toEqual([s]);
    expect(normalizeParams({}).spots).toEqual([]);
  });
});
