import { describe, expect, it } from 'vitest';
import { linearToSrgb, srgbToLinear, type Vec3 } from '../src/color/colorSpace';
import { DEFAULT_PARAMS, normalizeParams, type EditParams } from '../src/image-engine/params';
import { derive } from '../src/image-engine/derive';
import { processLinear, renderImage, renderPixel8 } from '../src/image-engine/pipeline';
import { linearToOklab } from '../src/image-engine/oklab';
import { EMPTY_RASTER, RASTER_SIZE, applyStroke, falloff, rasterize, sampleRaster } from '../src/masks/brush';
import { componentValue, flattenMasks, maskValue } from '../src/masks/evaluate';
import {
  addComponent, addMask, duplicateMask, limitReason, removeComponent, removeMask, setAdjust, updateMask, updateShape,
} from '../src/masks/ops';
import {
  MAX_COMPONENTS, MAX_MASKS, MAX_RASTERS, newComponent, newMask, newShape, normalizeMasks, spanOf, type BrushStroke, type Mask, type MaskOp, type Shape,
} from '../src/masks/types';
import { clearSegmentRasters, clearSegmentationProviders, firstAvailableProvider, registerSegmentationProvider, setSegmentRaster } from '../src/masks/segmentation';
import { px, scene, SCENE_H, SCENE_W } from './helpers';

const W = SCENE_W, H = SCENE_H;
const span = spanOf(W, H); // hw 0.5, hh 0.375
const P = (over: Partial<EditParams>): EditParams => ({ ...DEFAULT_PARAMS, ...over });
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps);
const mk = (shape: Shape, adjust: Mask['adjust'] = {}, extra: Partial<Mask> = {}): Mask => ({ ...newMask(shape, 'M'), adjust, ...extra });
const val = (m: Mask, x: number, y: number, c0: Vec3 = [0.3, 0.3, 0.3]) => maskValue(flattenMasks([m]), 0, x, y, c0);
const radial = (over: Record<string, number> = {}): Shape => ({ ...newShape('radial', span), cx: 0, cy: 0, rx: 0.2, ry: 0.2, rotation: 0, feather: 0, ...over } as Shape);
const linear = (over: Record<string, number> = {}): Shape => ({ ...newShape('linear', span), x1: 0, y1: -0.2, x2: 0, y2: 0.2, feather: 100, ...over } as Shape);
const stroke = (over: Partial<BrushStroke> = {}): BrushStroke => ({ points: [{ x: -0.2, y: 0, p: 1 }, { x: 0.2, y: 0, p: 1 }], radius: 0.06, feather: 0.5, flow: 1, density: 1, erase: false, ...over });
const maxOf = (a: ArrayLike<number>) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
const labOf = (srgb: [number, number, number]) => linearToOklab([srgbToLinear(srgb[0] / 255), srgbToLinear(srgb[1] / 255), srgbToLinear(srgb[2] / 255)]);

describe('mask semantics: 0 = none, 1 = full, in between = partial', () => {
  it('mask value 0 produces no local adjustment; value 1 produces the full adjustment', () => {
    const m = mk(radial({ rx: 0.1, ry: 0.1, feather: 0 }), { exposure: 1.5 });
    const p = P({ masks: [m] });
    const c: Vec3 = [0.12, 0.2, 0.05];
    const inside = renderPixel8([120, 150, 90], p); // 1x1 image: mask-space (0,0) = centre of the radial => m = 1
    expect(inside).toEqual(renderPixel8([120, 150, 90], P({ exposure: 1.5 }))); // identical to applying it globally
    // far outside the radial: untouched
    const d = derive(p, W, H);
    close(maskValue(d.masks, 0, 0.45, 0.3, c), 0);
    const src = scene();
    const out = renderImage(src, W, H, p).data, plain = renderImage(src, W, H, DEFAULT_PARAMS).data;
    expect(px(out, W, 1, 1)).toEqual(px(plain, W, 1, 1)); // corner pixel, m = 0
  });

  it('a 50 % mask gives half the adjustment (exactly half the stops for exposure)', () => {
    const c: Vec3 = [0.1, 0.2, 0.3];
    const half = processLinear(c, P({ masks: [mk(radial({ rx: 5, ry: 5, feather: 0 }), { exposure: 2 }, { amount: 50 })] }));
    const gain = Math.pow(2, 2 * 0.5);
    for (let i = 0; i < 3; i++) close(half[i], c[i] * gain, 1e-9);
    // contrast etc.: the delta is between none and full, close to half in encoded terms
    const at = (amount: number) => renderPixel8([90, 90, 90], P({ masks: [mk(radial({ rx: 5, ry: 5 }), { contrast: 100 }, { amount })] }))[0];
    const none = at(0), full = at(100), mid = at(50);
    expect(mid).toBeGreaterThan(Math.min(none, full)); expect(mid).toBeLessThan(Math.max(none, full));
    expect(Math.abs(mid - (none + full) / 2)).toBeLessThanOrEqual(3);
  });

  it('linear gradient: full at the start, none at the end, monotone between, feather controls softness', () => {
    const m = mk(linear({ feather: 100 }));
    const at = (y: number) => val(m, 0, y);
    close(at(-0.2), 1, 1e-9); close(at(0.2), 0, 1e-9); close(at(-0.3), 1); close(at(0.3), 0);
    let prev = 2; for (let y = -0.25; y <= 0.25; y += 0.01) { const v = at(y); expect(v).toBeLessThanOrEqual(prev + 1e-12); prev = v; }
    close(at(0), 0.5, 1e-9);
    const hard = mk(linear({ feather: 0 }));
    expect(val(hard, 0, -0.01)).toBeGreaterThan(0.99); expect(val(hard, 0, 0.01)).toBeLessThan(0.01); // step at the midpoint
    expect(val(m, 0.3, 0)).toBeCloseTo(val(m, -0.3, 0)); // perpendicular offset doesn't matter
  });

  it('radial gradient: width, height, rotation, feather, invert', () => {
    const base = mk(radial({ rx: 0.3, ry: 0.1, feather: 0 }));
    expect(val(base, 0.25, 0)).toBe(1); expect(val(base, 0, 0.15)).toBe(0);
    const rot = mk(radial({ rx: 0.3, ry: 0.1, feather: 0, rotation: 90 }));
    expect(val(rot, 0.25, 0)).toBe(0); expect(val(rot, 0, 0.25)).toBe(1); // rotated a quarter turn
    const soft = mk(radial({ rx: 0.3, ry: 0.3, feather: 100 }));
    expect(val(soft, 0, 0)).toBe(1);
    const a = val(soft, 0.1, 0), b = val(soft, 0.2, 0);
    expect(a).toBeGreaterThan(b); expect(b).toBeGreaterThan(0); expect(a).toBeLessThan(1); // smooth, no hard edge
    const inv = { ...base, components: [{ ...base.components[0], invert: true }] };
    expect(val(inv, 0.25, 0)).toBe(0); expect(val(inv, 0, 0.15)).toBe(1);
    expect(val({ ...base, invert: true }, 0.25, 0)).toBe(0);
  });

  it('component ops: add = union, subtract = difference, intersect = overlap; a leading subtract starts from everything', () => {
    const left = newComponent(radial({ cx: -0.15, rx: 0.2, ry: 0.2 }), 'add'), right = (op: MaskOp) => newComponent(radial({ cx: 0.15, rx: 0.2, ry: 0.2 }), op);
    const make = (op: MaskOp): Mask => ({ ...mk(radial()), components: [left, right(op)] });
    expect(val(make('add'), -0.3, 0)).toBe(1); expect(val(make('add'), 0.3, 0)).toBe(1); expect(val(make('add'), 0, 0)).toBe(1); expect(val(make('add'), 0, 0.3)).toBe(0);
    expect(val(make('subtract'), -0.3, 0)).toBe(1); expect(val(make('subtract'), 0.3, 0)).toBe(0); expect(val(make('subtract'), 0, 0)).toBe(0); // overlap removed
    expect(val(make('intersect'), 0, 0)).toBe(1); expect(val(make('intersect'), -0.3, 0)).toBe(0);
    const everythingBut: Mask = { ...mk(radial()), components: [newComponent(radial({ cx: 0, rx: 0.2, ry: 0.2 }), 'subtract')] };
    expect(val(everythingBut, 0, 0)).toBe(0); expect(val(everythingBut, 0.4, 0.3)).toBe(1);
  });

  it('mask amount scales, masks apply cumulatively, disabled masks are ignored', () => {
    const a = mk(radial({ rx: 5, ry: 5 }), { exposure: 1 }), b = mk(radial({ rx: 5, ry: 5 }), { exposure: 1 });
    const c: Vec3 = [0.1, 0.1, 0.1];
    close(processLinear(c, P({ masks: [a, b] }))[0], 0.4, 1e-9); // +1 and +1 stops
    expect(processLinear(c, P({ masks: [a, { ...b, enabled: false }] }))[0]).toBeCloseTo(0.2, 9);
    expect(val({ ...a, amount: 30 }, 0, 0)).toBeCloseTo(0.3, 9);
    expect(derive(P({ masks: [{ ...a, enabled: false }] }), 4, 4).masks.count).toBe(0);
  });
});

describe('brush mask', () => {
  it('paints where you stroke with a soft edge, and nowhere else', () => {
    const r = rasterize([stroke()]);
    const at = (x: number, y: number) => sampleRaster(r, x, y);
    expect(at(0, 0)).toBeGreaterThan(0.98);
    expect(at(0, 0.03)).toBeGreaterThan(0.9); // inside the solid core
    const edge = at(0, 0.055); expect(edge).toBeGreaterThan(0.02); expect(edge).toBeLessThan(0.9); // feathered edge
    expect(at(0, 0.2)).toBe(0); expect(at(0.4, 0)).toBe(0);
    expect(at(-0.2, 0)).toBeGreaterThan(0.95); expect(at(0.2, 0)).toBeGreaterThan(0.95); // stroke endpoints
  });

  it('size, feather, density and flow behave', () => {
    const w = (radius: number) => { const r = rasterize([stroke({ radius })]); let n = 0; for (let i = 0; i < r.length; i++) if (r[i] > 128) n++; return n; };
    expect(w(0.1)).toBeGreaterThan(w(0.04) * 2);
    const hardEdge = rasterize([stroke({ feather: 0 })]), softEdge = rasterize([stroke({ feather: 1 })]);
    expect(sampleRaster(hardEdge, 0, 0.05)).toBeGreaterThan(sampleRaster(softEdge, 0, 0.05));
    const dens = rasterize([stroke({ density: 0.4 })]);
    expect(maxOf(dens)).toBeLessThanOrEqual(Math.round(0.4 * 255) + 1); // density caps the stroke
    // flow < 1 builds up as you paint: one dab is faint, a long stroke over the same spot is stronger
    const dab = rasterize([stroke({ flow: 0.2, points: [{ x: 0, y: 0, p: 1 }] })]), drag = rasterize([stroke({ flow: 0.2, points: [{ x: -0.05, y: 0, p: 1 }, { x: 0.05, y: 0, p: 1 }] })]);
    expect(sampleRaster(dab, 0, 0)).toBeCloseTo(0.2, 1);
    expect(sampleRaster(drag, 0, 0)).toBeGreaterThan(sampleRaster(dab, 0, 0) + 0.2);
    close(falloff(0, 0.5), 1, 1e-12); close(falloff(1, 0.5), 0, 1e-12);
  });

  it('erase removes what earlier strokes painted; overlapping strokes add up', () => {
    const paint = stroke(), erase = stroke({ erase: true, points: [{ x: 0, y: 0, p: 1 }], radius: 0.04, feather: 0 });
    const r = rasterize([paint, erase]);
    expect(sampleRaster(r, 0, 0)).toBeLessThan(0.05); // erased
    expect(sampleRaster(r, -0.15, 0)).toBeGreaterThan(0.95); // untouched part remains
    const two = rasterize([stroke({ flow: 0.5, density: 0.5 }), stroke({ flow: 0.5, density: 0.5 })]);
    expect(sampleRaster(two, 0, 0)).toBeCloseTo(0.75, 1); // 1 − (1−0.25)… union of two half-strength strokes
  });

  it('pressure scales the brush; strokes round-trip through JSON; rasters are cached and incremental', () => {
    const light = rasterize([stroke({ points: [{ x: 0, y: 0, p: 0 }] })]), firm = rasterize([stroke({ points: [{ x: 0, y: 0, p: 1 }] })]);
    const area = (r: Uint8Array) => { let n = 0; for (let i = 0; i < r.length; i++) if (r[i] > 100) n++; return n; };
    expect(area(firm)).toBeGreaterThan(area(light) * 2);
    const strokes = [stroke(), stroke({ points: [{ x: 0, y: -0.1, p: 1 }, { x: 0.1, y: -0.1, p: 1 }] })];
    expect(rasterize(strokes)).toBe(rasterize(strokes)); // identity cache
    const first = rasterize([strokes[0]]);
    const extended = rasterize([strokes[0], strokes[1]]); // reuses the previous result
    const fresh = rasterize(JSON.parse(JSON.stringify([strokes[0], strokes[1]]))); // forced full recompute
    expect(Array.from(extended)).toEqual(Array.from(fresh));
    expect(first).not.toBe(extended);
    expect(EMPTY_RASTER.length).toBe(RASTER_SIZE * RASTER_SIZE);
    const buf = new Float32Array(RASTER_SIZE * RASTER_SIZE); applyStroke(buf, stroke({ points: [] })); expect(maxOf(buf)).toBe(0);
  });

  it('a brush component drives the mask in the rendered image', () => {
    const m = mk({ type: 'brush', strokes: [stroke({ radius: 0.1 })] }, { exposure: -2 });
    const src = scene();
    const out = renderImage(src, W, H, P({ masks: [m] })).data, plain = renderImage(src, W, H, DEFAULT_PARAMS).data;
    expect(px(out, W, W / 2, H / 2)[0]).toBeLessThan(px(plain, W, W / 2, H / 2)[0] - 15); // painted: darkened
    expect(px(out, W, 1, H - 2)).toEqual(px(plain, W, 1, H - 2)); // unpainted: untouched
  });
});

describe('colour range mask', () => {
  const lab = labOf([60, 180, 80]); // a green
  const shape = (range: number): Shape => ({ type: 'color', L: lab[0], a: lab[1], b: lab[2], range });
  const vOf = (range: number, srgb: [number, number, number]) => val(mk(shape(range)), 0, 0, srgb.map((v) => srgbToLinear(v / 255)) as Vec3);

  it('selects similar colours, rejects different ones, and fades smoothly in between', () => {
    expect(vOf(30, [60, 180, 80])).toBeGreaterThan(0.99);
    expect(vOf(30, [70, 175, 90])).toBeGreaterThan(0.9); // near-identical green
    expect(vOf(30, [60, 90, 220])).toBe(0); // blue: rejected
    expect(vOf(30, [220, 60, 60])).toBe(0);
    const mids = [[90, 160, 90], [110, 150, 100], [130, 140, 110], [150, 130, 110]].map((c) => vOf(30, c as [number, number, number]));
    expect(mids.some((v) => v > 0.05 && v < 0.95)).toBe(true); // partial inclusion
    for (let i = 1; i < mids.length; i++) expect(mids[i]).toBeLessThanOrEqual(mids[i - 1] + 1e-9);
  });

  it('the range / fuzziness control widens the selection', () => {
    const c: [number, number, number] = [110, 150, 100];
    expect(vOf(10, c)).toBeLessThan(vOf(40, c)); expect(vOf(40, c)).toBeLessThan(vOf(90, c) + 1e-9);
    expect(vOf(100, [150, 175, 70])).toBeGreaterThan(vOf(10, [150, 175, 70]));
  });

  it('works in a render: only the green patches are changed', () => {
    const src = scene();
    const out = renderImage(src, W, H, P({ masks: [mk(shape(25), { saturation: -100 })] })).data, plain = renderImage(src, W, H, DEFAULT_PARAMS).data;
    const at = (d: Uint8ClampedArray, x: number, y: number) => px(d, W, x, y);
    // find a green patch pixel (patch 3 of 8) and a red one (patch 0) in the scene
    const gx = Math.floor(W * 0.4), rx = 2, y = Math.floor(H * 0.6);
    const g = at(out, gx, y), gp = at(plain, gx, y);
    expect(gp[1]).toBeGreaterThan(gp[0] + 50); // it is green in the original
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(25); // desaturated by the mask
    expect(at(out, rx, y)).toEqual(at(plain, rx, y)); // red patch untouched
  });
});

describe('luminance range mask', () => {
  const vOf = (min: number, max: number, smooth: number, enc: number) => val(mk({ type: 'luminance', min, max, smooth }), 0, 0, [1, 1, 1].map(() => srgbToLinear(enc)) as Vec3);

  it('"only the brightest 20 %": bright tones in, dark tones out, smooth transition', () => {
    expect(vOf(80, 100, 10, 0.97)).toBeGreaterThan(0.99); expect(vOf(80, 100, 10, 1)).toBe(1);
    expect(vOf(80, 100, 10, 0.5)).toBe(0); expect(vOf(80, 100, 10, 0.05)).toBe(0);
    const t = [0.72, 0.76, 0.8, 0.84, 0.88].map((v) => vOf(80, 100, 10, v));
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]); // monotone
    expect(t[2]).toBeCloseTo(0.5, 1); // 50 % at the threshold
    expect(vOf(80, 100, 0, 0.79)).toBeLessThan(0.05); expect(vOf(80, 100, 0, 0.81)).toBeGreaterThan(0.95); // no smoothing = sharp
  });

  it('min/max window and open-ended ends', () => {
    expect(vOf(30, 60, 5, 0.45)).toBeGreaterThan(0.99); expect(vOf(30, 60, 5, 0.1)).toBe(0); expect(vOf(30, 60, 5, 0.9)).toBe(0);
    expect(vOf(0, 30, 10, 0)).toBe(1); // "min = 0" includes pure black completely (no half-strength edge)
    expect(vOf(0, 100, 10, 0.5)).toBe(1);
  });
});

describe('mask list operations', () => {
  it('add / update / remove keep untouched masks identical (structural sharing) and stay valid', () => {
    const a = mk(radial(), { exposure: 1 }), b = mk(linear(), { saturation: 20 });
    let ms = addMask(addMask([], a), b);
    const next = setAdjust(ms, a.id, 'contrast', 30);
    expect(next[1]).toBe(ms[1]); expect(next[0]).not.toBe(ms[0]); expect(next[0].adjust).toEqual({ exposure: 1, contrast: 30 });
    expect(setAdjust(next, a.id, 'contrast', 0)[0].adjust).toEqual({ exposure: 1 }); // 0 removes the key
    ms = updateMask(ms, b.id, (m) => ({ ...m, name: 'Sky' }));
    expect(ms[1].name).toBe('Sky');
    const moved = updateShape<Extract<Shape, { type: 'radial' }>>(ms, a.id, a.components[0].id, (s) => ({ ...s, cx: 0.2 }));
    expect((moved[0].components[0].shape as { cx: number }).cx).toBe(0.2);
    expect(removeMask(ms, a.id)).toHaveLength(1);
    const two = addComponent(ms, a.id, newComponent(linear(), 'subtract'));
    expect(two[0].components).toHaveLength(2);
    expect(removeComponent(two, a.id, two[0].components[1].id)[0].components).toHaveLength(1);
    expect(removeComponent(ms, a.id, a.components[0].id)).toHaveLength(1); // last component removed => mask removed
    expect(duplicateMask(ms, a.id)).toHaveLength(3);
  });

  it('limits: masks, components and raster layers are capped with a clear reason', () => {
    let ms: Mask[] = [];
    for (let i = 0; i < MAX_MASKS; i++) ms = addMask(ms, mk(radial()));
    expect(limitReason(ms, radial(), true)).toMatch(/masks/);
    expect(limitReason([], radial(), true)).toBeNull();
    let many: Mask[] = [mk(radial())];
    for (let i = 1; i < MAX_COMPONENTS; i++) many = addComponent(many, many[0].id, newComponent(radial()));
    expect(limitReason(many, radial(), false)).toMatch(/components/);
    let brushes: Mask[] = [mk({ type: 'brush', strokes: [] })];
    for (let i = 1; i < MAX_RASTERS; i++) brushes = addComponent(brushes, brushes[0].id, newComponent({ type: 'brush', strokes: [] }));
    expect(limitReason(brushes, { type: 'brush', strokes: [] }, false)).toMatch(/brush/);
    expect(limitReason(brushes, radial(), false)).toBeNull();
    // flattening never exceeds the shader budget even for oversized input
    const big = Array.from({ length: 20 }, () => mk(radial()));
    expect(flattenMasks(big).count).toBeLessThanOrEqual(MAX_MASKS);
    expect(flattenMasks(big).comps.length).toBeLessThanOrEqual(MAX_COMPONENTS);
  });

  it('masks persist: normalisation accepts what we saved and repairs or drops bad data', () => {
    const m = mk({ type: 'brush', strokes: [stroke()] }, { exposure: -0.5, clarity: 15 }, { name: 'Sky', amount: 80 });
    const back = normalizeMasks(JSON.parse(JSON.stringify([m])));
    expect(back).toEqual([m]);
    expect(normalizeMasks('nope')).toEqual([]);
    expect(normalizeMasks([{ id: 1 }, null, { id: 'x', components: 'no' }])).toEqual([]);
    const fixed = normalizeMasks([{ id: 'a', components: [{ id: 'c', shape: { type: 'radial', rx: -5, feather: 500 } }], amount: 900, adjust: { exposure: 'x', clarity: 10, bogus: 1 } }]);
    expect(fixed[0].amount).toBe(100); expect(fixed[0].adjust).toEqual({ clarity: 10 });
    expect((fixed[0].components[0].shape as { rx: number; feather: number }).rx).toBeGreaterThan(0);
    expect((fixed[0].components[0].shape as { feather: number }).feather).toBe(100);
    expect(normalizeParams({ masks: [m] }).masks).toEqual([m]);
  });
});

describe('local adjustments: the example from the spec', () => {
  it('"darken the background, leave the subject": exposure −0.5, saturation −10, clarity +15 inside the mask only', () => {
    const subject = { ...newShape('radial', span), cx: 0, cy: 0, rx: 0.12, ry: 0.12, feather: 10 } as Shape;
    const background: Mask = { ...mk(subject, { exposure: -0.5, saturation: -10, clarity: 15 }), name: 'Background', invert: true };
    const src = scene();
    const out = renderImage(src, W, H, P({ masks: [background] })).data, plain = renderImage(src, W, H, DEFAULT_PARAMS).data;
    expect(px(out, W, W / 2, H / 2)).toEqual(px(plain, W, W / 2, H / 2)); // subject (centre) untouched
    expect(px(out, W, 3, 3)[2]).toBeLessThan(px(plain, W, 3, 3)[2]); // background darker
  });

  it('masked clarity / texture / dehaze act only inside the mask', () => {
    const w = 64, h = 32, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = i % w < 32 ? 105 : 150; src.set([v, v, v, 255], i * 4); } // one vertical edge at x = 32
    const hw = w / Math.max(w, h) / 2;
    const leftMask = mk({ ...newShape('linear', spanOf(w, h)), x1: -hw * 0.2, y1: 0, x2: 0.1, y2: 0, feather: 0 } as Shape, { clarity: 100 }); // covers the left half
    const out = renderImage(src, w, h, P({ masks: [leftMask] })).data;
    expect(px(out, w, 31, 16)[0]).toBeLessThan(105 - 3); // at the edge, inside the mask: overshoot
    expect(px(out, w, 33, 16)[0]).toBe(150); // other side of the edge: outside the mask, untouched
    expect(px(out, w, 5, 16)[0]).toBe(105); // flat areas stay flat
    const hz = mk(radial({ rx: 5, ry: 5 }), { dehaze: 100 });
    const hazy = new Uint8ClampedArray(8 * 8 * 4).fill(190); for (let i = 3; i < hazy.length; i += 4) hazy[i] = 255;
    expect(renderImage(hazy, 8, 8, P({ masks: [hz] })).data[0]).toBeLessThan(190 - 20);
    expect(renderImage(hazy, 8, 8, DEFAULT_PARAMS).data[0]).toBe(190);
    expect(linearToSrgb(0.5)).toBeGreaterThan(0.7);
  });
});

describe('AI selection architecture (no model is installed)', () => {
  it('reports no available provider and never fabricates a selection', async () => {
    clearSegmentationProviders();
    expect(await firstAvailableProvider()).toBeNull();
    const m = mk({ type: 'segment', kind: 'subject' }, { exposure: -2 });
    const t = flattenMasks([m]);
    expect(maskValue(t, 0, 0, 0, [0.3, 0.3, 0.3])).toBe(0); // empty until a provider supplies a raster
    expect(componentValue(t, 0, 0.1, 0.1, [0.3, 0.3, 0.3])).toBe(0);
  });

  it('a registered provider\'s raster is used exactly like a brush raster (plug-in test double)', async () => {
    const half = new Uint8Array(RASTER_SIZE * RASTER_SIZE);
    for (let y = 0; y < RASTER_SIZE; y++) for (let x = 0; x < RASTER_SIZE / 2; x++) half[y * RASTER_SIZE + x] = 255; // left half selected
    registerSegmentationProvider({ id: 'test-double', name: 'Test double (not a model)', available: () => true, segment: async () => half });
    const provider = await firstAvailableProvider();
    expect(provider?.id).toBe('test-double');
    const m = mk({ type: 'segment', kind: 'subject' }, { exposure: -2 });
    setSegmentRaster(m.components[0].id, await provider!.segment({} as ImageBitmap, 'subject'));
    const t = flattenMasks([m]);
    expect(maskValue(t, 0, -0.25, 0, [0.3, 0.3, 0.3])).toBe(1); expect(maskValue(t, 0, 0.25, 0, [0.3, 0.3, 0.3])).toBe(0);
    clearSegmentRasters(); clearSegmentationProviders();
  });
});
