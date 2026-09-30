import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/image-engine/params';
import { NO_DETAIL, applyAllDetail, applyDetail, boxMean, detailActive, detailParamsOf, gaussianBlur, globalDetailActive, guidedFilter, type DetailParams } from '../src/image-engine/detail';
import { NO_PARAMETRIC, buildLut, defaultCurves, parametricCurve, sampleLut } from '../src/image-engine/curves';
import { lutFor } from '../src/image-engine/derive';
import { newMask, newShape } from '../src/masks/types';

// deterministic noise
let seed = 1;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const W = 96, H = 64;
const D = (o: Partial<DetailParams>): DetailParams => ({ ...NO_DETAIL, ...o });

function make(fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); d.set([r, g, b, 255], (y * W + x) * 4); }
  return d;
}
const lum = (d: Uint8ClampedArray, x: number, y: number) => 0.2126 * d[(y * W + x) * 4] + 0.7152 * d[(y * W + x) * 4 + 1] + 0.0722 * d[(y * W + x) * 4 + 2];
/** RMS difference of luma between two images over a region. */
const rms = (a: Uint8ClampedArray, b: Uint8ClampedArray, x0 = 0, x1 = W, y0 = 0, y1 = H) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = lum(a, x, y) - lum(b, x, y); s += d * d; n++; } return Math.sqrt(s / n); };

const clean = make((x) => (x < 48 ? [70, 90, 110] : [200, 190, 170]));
const noisy = (() => { seed = 7; return make((x) => { const n = gauss() * 10; const c = x < 48 ? [70, 90, 110] : [200, 190, 170]; return [c[0] + n, c[1] + n, c[2] + n]; }); })();

describe('primitives', () => {
  it('box mean of a constant is that constant; gaussian of an impulse sums to 1 with the right width', () => {
    const c = new Float32Array(W * H).fill(5); expect(boxMean(c, W, H, 3).every((v) => Math.abs(v - 5) < 1e-4)).toBe(true);
    const imp = new Float32Array(W * H); imp[32 * W + 48] = 1000;
    const g = gaussianBlur(imp, W, H, 3); let sum = 0, vx = 0;
    for (let x = 0; x < W; x++) { const v = g[32 * W + x]; vx += v * (x - 48) ** 2; }
    for (const v of g) sum += v; expect(sum).toBeCloseTo(1000, 0);
    let mass = 0; for (let x = 0; x < W; x++) mass += g[32 * W + x];
    expect(Math.sqrt(vx / mass)).toBeGreaterThan(2.6); expect(Math.sqrt(vx / mass)).toBeLessThan(3.4);
  });
  it('guided filter keeps flat areas flat and sharp edges sharp', () => {
    const I = new Float32Array(W * H); for (let i = 0; i < I.length; i++) I[i] = i % W < 48 ? 50 : 200;
    const q = guidedFilter(I, I, W, H, 3, 100);
    expect(Math.abs(q[10] - 50)).toBeLessThan(0.5); expect(Math.abs(q[47] - 50)).toBeLessThan(2); expect(Math.abs(q[48] - 200)).toBeLessThan(2);
  });
});

describe('noise reduction', () => {
  it('does nothing when off, and never modifies its input', () => {
    expect(applyDetail(noisy, W, H, NO_DETAIL)).toBe(noisy);
    const copy = new Uint8ClampedArray(noisy); applyDetail(noisy, W, H, D({ nrLuma: 80, sharpAmount: 80, nrColor: 50 }));
    expect(Array.from(noisy)).toEqual(Array.from(copy));
  });
  it('luminance NR removes most of the noise in flat areas', () => {
    const before = rms(noisy, clean, 4, 40, 4, 60);
    const out = applyDetail(noisy, W, H, D({ nrLuma: 70, nrLumaDetail: 0 }));
    expect(rms(out, clean, 4, 40, 4, 60)).toBeLessThan(before * 0.5);
  });
  it('…but keeps a strong edge (edge-preserving, not a blur)', () => {
    const out = applyDetail(noisy, W, H, D({ nrLuma: 70, nrLumaDetail: 0 }));
    const step = (d: Uint8ClampedArray, a: number, b: number) => { let s = 0; for (let y = 8; y < 56; y++) s += lum(d, a, y) - lum(d, b, y); return s / 48; };
    expect(step(out, 49, 46)).toBeGreaterThan(0.93 * step(clean, 49, 46));
    // a plain blur of comparable strength would soften it: the jump across 47|48 stays (nearly) a single-pixel step
    expect(step(out, 48, 47)).toBeGreaterThan(0.85 * step(clean, 48, 47));
  });
  it('more strength → less noise; higher Detail keeps more of it', () => {
    const r = (o: Partial<DetailParams>) => rms(applyDetail(noisy, W, H, D(o)), clean, 4, 40, 4, 60);
    expect(r({ nrLuma: 80, nrLumaDetail: 0 })).toBeLessThan(r({ nrLuma: 30, nrLumaDetail: 0 }));
    expect(r({ nrLuma: 60, nrLumaDetail: 100 })).toBeGreaterThan(r({ nrLuma: 60, nrLumaDetail: 0 }));
  });
  it('Contrast restores local contrast of the smoothed picture (texture amplitude grows)', () => {
    const tex = make((x, y) => { const v = 120 + 10 * Math.sin(x * 0.5) * Math.cos(y * 0.5); return [v, v, v]; });
    const amp = (d: Uint8ClampedArray) => { let mn = 255, mx = 0; for (let y = 8; y < 56; y++) for (let x = 8; x < 88; x++) { const l = lum(d, x, y); mn = Math.min(mn, l); mx = Math.max(mx, l); } return mx - mn; };
    const a = amp(applyDetail(tex, W, H, D({ nrLuma: 30, nrLumaDetail: 0, nrLumaContrast: 0 })));
    const b = amp(applyDetail(tex, W, H, D({ nrLuma: 30, nrLumaDetail: 0, nrLumaContrast: 100 })));
    expect(b).toBeGreaterThan(a);
  });
  it('colour NR removes chroma noise without touching luminance or colour edges', () => {
    seed = 11;
    const cn = make((x) => { const n1 = gauss() * 14, n2 = gauss() * 14; const base = x < 48 ? [100, 120, 140] : [200, 120, 90]; return [base[0] + n1, base[1], base[2] + n2]; });
    const cl = make((x) => (x < 48 ? [100, 120, 140] : [200, 120, 90]));
    const chroma = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let s = 0, n = 0; for (let y = 4; y < 60; y++) for (let x = 4; x < 40; x++) { const i = (y * W + x) * 4; s += (a[i] - a[i + 1] - (b[i] - b[i + 1])) ** 2 + (a[i + 2] - a[i + 1] - (b[i + 2] - b[i + 1])) ** 2; n++; } return Math.sqrt(s / n); };
    const out = applyDetail(cn, W, H, D({ nrColor: 100, nrColorSmooth: 50, nrColorDetail: 50 }));
    expect(chroma(out, cl)).toBeLessThan(chroma(cn, cl) * 0.6);
    expect(Math.abs(rms(out, cn, 4, 40, 4, 60))).toBeLessThan(6); // luma barely moves
    const edge = (d: Uint8ClampedArray) => d[(30 * W + 52) * 4] - d[(30 * W + 44) * 4]; // red channel across the colour edge
    expect(edge(out)).toBeGreaterThan(edge(cl) * 0.8);
  });
});

describe('sharpening', () => {
  const edge = make((x) => (x < 48 ? [90, 90, 90] : [170, 170, 170]));
  it('steepens an edge with overshoot on both sides; flat areas stay put', () => {
    const out = applyDetail(edge, W, H, D({ sharpAmount: 100, sharpRadius: 1, sharpDetail: 100 }));
    expect(lum(out, 47, 30)).toBeLessThan(90 - 3); expect(lum(out, 48, 30)).toBeGreaterThan(170 + 3);
    expect(Math.abs(lum(out, 10, 30) - 90)).toBeLessThan(0.6); expect(Math.abs(lum(out, 85, 30) - 170)).toBeLessThan(0.6);
  });
  it('amount scales the effect; 0 is identity', () => {
    const at = (a: number) => lum(applyDetail(edge, W, H, D({ sharpAmount: a, sharpDetail: 100 })), 48, 30);
    expect(at(150)).toBeGreaterThan(at(60)); expect(at(60)).toBeGreaterThan(at(20));
    expect(applyDetail(edge, W, H, D({ sharpAmount: 0 }))).toBe(edge);
  });
  it('a larger radius spreads the halo further from the edge', () => {
    const at = (r: number) => Math.abs(lum(applyDetail(edge, W, H, D({ sharpAmount: 100, sharpRadius: r, sharpDetail: 100 })), 44, 30) - 90);
    expect(at(3)).toBeGreaterThan(at(0.6) + 0.5);
  });
  it('Detail suppresses halos at strong edges (low Detail → smaller overshoot)', () => {
    const over = (d: number) => lum(applyDetail(edge, W, H, D({ sharpAmount: 100, sharpDetail: d })), 48, 30) - 170;
    expect(over(0)).toBeLessThan(over(100) * 0.75);
  });
  it('Masking confines sharpening to edges: fine noise is left alone, the edge is still sharpened', () => {
    seed = 3; const noisyEdge = make((x) => { const n = gauss() * 2; const v = (x < 48 ? 90 : 170) + n; return [v, v, v]; });
    const flatChange = (m: number) => rms(applyDetail(noisyEdge, W, H, D({ sharpAmount: 120, sharpDetail: 100, sharpMasking: m })), noisyEdge, 4, 40, 4, 60);
    expect(flatChange(100)).toBeLessThan(flatChange(0) * 0.35);
    const out = applyDetail(noisyEdge, W, H, D({ sharpAmount: 120, sharpDetail: 100, sharpMasking: 100 }));
    expect(lum(out, 48, 30)).toBeGreaterThan(lum(noisyEdge, 48, 30) + 2);
  });
  it('preserves colour (luma-only) and alpha', () => {
    const c = make((x) => (x < 48 ? [200, 60, 60] : [60, 60, 200]));
    for (let i = 3; i < c.length; i += 4) c[i] = 123;
    const out = applyDetail(c, W, H, D({ sharpAmount: 100 }));
    expect(out[3]).toBe(123);
    const i = (30 * W + 47) * 4; // the same Y shift lands on each channel, so channel differences are preserved
    expect(Math.abs((out[i] - out[i + 2]) - (c[i] - c[i + 2]))).toBeLessThanOrEqual(2);
  });
  it('radius is in ORIGINAL pixels: a half-size preview (scale 0.5) uses half the blur radius', () => {
    const at = (s: number) => Math.abs(lum(applyDetail(edge, W, H, D({ sharpAmount: 100, sharpRadius: 3, sharpDetail: 100 }), s), 44, 30) - 90);
    expect(at(0.5)).toBeLessThan(at(1));
  });
});

describe('per-mask Sharpness / Noise', () => {
  const m = (adjust: Record<string, number>) => { const k = newMask(newShape('radial', { hw: 0.5, hh: 0.33 }), 'M'); const s = k.components[0].shape; if (s.type === 'radial') Object.assign(s, { cx: -0.25, cy: 0, rx: 0.2, ry: 0.4, feather: 10 }); return { ...k, adjust }; };
  it('a mask with Sharpness sharpens only inside it', () => {
    const edge = make((x) => (x % 24 < 12 ? [90, 90, 90] : [170, 170, 170])); // edges on both sides of the picture
    const out = applyAllDetail(edge, W, H, NO_DETAIL, [m({ sharpness: 100 })]);
    const inside = rms(out, edge, 4, 40), outside = rms(out, edge, 60, 92);
    expect(inside).toBeGreaterThan(2); expect(outside).toBeLessThan(0.3);
  });
  it('a mask with Noise denoises only inside it', () => {
    const out = applyAllDetail(noisy, W, H, NO_DETAIL, [m({ noise: 100 })]);
    expect(rms(out, clean, 4, 40, 4, 60)).toBeLessThan(rms(noisy, clean, 4, 40, 4, 60) * 0.7);
    expect(rms(out, noisy, 60, 92)).toBeLessThan(0.3);
  });
  it('negative Sharpness softens edges', () => {
    const edge = make((x) => (x % 24 < 12 ? [90, 90, 90] : [170, 170, 170]));
    const out = applyAllDetail(edge, W, H, NO_DETAIL, [m({ sharpness: -100 })]);
    expect(Math.abs(lum(out, 11, 30) - lum(out, 12, 30))).toBeLessThan(Math.abs(lum(edge, 11, 30) - lum(edge, 12, 30)));
  });
  it('activity flags', () => {
    expect(detailActive(NO_DETAIL, [])).toBe(false); expect(globalDetailActive(D({ nrColor: 1 }))).toBe(true);
    expect(detailActive(NO_DETAIL, [m({ noise: 5 })])).toBe(true); expect(detailActive(NO_DETAIL, [{ ...m({ noise: 5 }), enabled: false }])).toBe(false);
    expect(detailParamsOf({ sharpAmount: 40, junk: 1 }).sharpAmount).toBe(40);
  });
});

describe('parametric curve', () => {
  it('is the identity with all sliders at zero and pins black and white', () => {
    for (let i = 0; i <= 20; i++) expect(parametricCurve(i / 20, NO_PARAMETRIC)).toBeCloseTo(i / 20, 9);
    const p = { shadows: 1, darks: -1, lights: 1, highlights: -1 };
    expect(parametricCurve(0, p)).toBe(0); expect(parametricCurve(1, p)).toBe(1);
  });
  it('each slider moves its own tonal region', () => {
    expect(parametricCurve(0.875, { ...NO_PARAMETRIC, highlights: 1 })).toBeGreaterThan(0.875 + 0.02);
    expect(parametricCurve(0.125, { ...NO_PARAMETRIC, shadows: 1 })).toBeGreaterThan(0.125 + 0.01);
    expect(parametricCurve(0.375, { ...NO_PARAMETRIC, darks: -1 })).toBeLessThan(0.375 - 0.02);
    expect(Math.abs(parametricCurve(0.125, { ...NO_PARAMETRIC, highlights: 1 }) - 0.125)).toBeLessThan(1e-9); // far region untouched
    expect(parametricCurve(0.625, { ...NO_PARAMETRIC, lights: 1 })).toBeGreaterThan(0.625 + 0.02);
  });
  it('is monotone for every slider combination (no tone inversion)', () => {
    seed = 5;
    for (let k = 0; k < 400; k++) {
      const p = { shadows: rnd() * 2 - 1, darks: rnd() * 2 - 1, lights: rnd() * 2 - 1, highlights: rnd() * 2 - 1 };
      let prev = -1; for (let i = 0; i <= 400; i++) { const y = parametricCurve(i / 400, p); expect(y).toBeGreaterThanOrEqual(prev - 1e-12); prev = y; }
    }
    const worst = { shadows: -1, darks: 1, lights: -1, highlights: 1 }; let prev = -1; for (let i = 0; i <= 400; i++) { const y = parametricCurve(i / 400, worst); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
  });
  it('feeds the same lookup table the GPU uses (point curve is applied after it)', () => {
    const lut = buildLut(defaultCurves(), { ...NO_PARAMETRIC, highlights: 1 });
    expect(sampleLut(lut, 1, 0.875)).toBeGreaterThan(0.89);
    const p = { ...DEFAULT_PARAMS, curveHighlights: 100 };
    expect(sampleLut(lutFor(p), 0, 0.875)).toBeCloseTo(sampleLut(lut, 0, 0.875), 6);
    expect(lutFor(DEFAULT_PARAMS)).not.toBe(lutFor(p)); // cached per slider state
  });
});
