import { describe, expect, it } from 'vitest';
import { srgbToLinear } from '../src/color/colorSpace';
import {
  ASPECT_PRESETS, FULL_CROP, dragCrop, fitCropInside, fitRatio, fullCrop, isFullCrop, normalizeCrop, presetRatio, type Crop,
} from '../src/geometry/crop';
import {
  DEFAULT_GEO, IDENTITY, geoMatrix, inv3, makeGeoMap, maskToOutput, mul3, outputSize, outputToMask, outputToSource, project,
  rectInsideSource, sourceToOutput, type GeoParams,
} from '../src/geometry/transform';
import { edgeSamples, estimateUpright, grayFromRgba, type EdgeSample } from '../src/geometry/upright';
import { effectiveLens, getLensProfile, listLensProfiles, registerLensProfile } from '../src/lens/profiles';
import { DEFAULT_PARAMS, normalizeParams, type EditParams } from '../src/image-engine/params';
import { derive } from '../src/image-engine/derive';
import { renderImage, sampleSource } from '../src/image-engine/pipeline';
import { px, scene, SCENE_H, SCENE_W } from './helpers';

const P = (over: Partial<EditParams>): EditParams => ({ ...DEFAULT_PARAMS, ...over });
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps);
const W = SCENE_W, H = SCENE_H;
const G = (over: Partial<GeoParams>): GeoParams => ({ ...DEFAULT_GEO, ...over });

describe('geometry transform', () => {
  it('default geometry is the identity and inverts cleanly', () => {
    expect(geoMatrix(DEFAULT_GEO, 300, 200).map((v) => Math.round(v * 1e9) / 1e9)).toEqual(IDENTITY.map((v) => v + 0));
    const m = geoMatrix(G({ straighten: 7, geoVertical: 30, geoHorizontal: -15, geoScale: 120, geoOffsetX: 10, orientation: 1, geoAspect: 25, geoRotate: 2 }), 300, 200);
    const id = mul3(m, inv3(m));
    IDENTITY.forEach((v, i) => close(id[i], v, 1e-9));
  });

  it('forward and inverse mappings round-trip for arbitrary parameters', () => {
    const p = P({ straighten: -8, geoVertical: 25, geoHorizontal: 12, geoScale: 90, geoOffsetY: -6, orientation: 3, flipH: 1, crop: { ...fullCrop(), x: 0.1, y: 0.2, w: 0.6, h: 0.5 } });
    const map = makeGeoMap(p, 300, 200);
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.3], [0.25, 0.8]]) {
      const s = outputToSource(map, u, v)!;
      const back = sourceToOutput(map, s[0], s[1])!;
      close(back[0], u, 1e-9); close(back[1], v, 1e-9);
      const m = outputToMask(map, u, v)!, o = maskToOutput(map, m[0], m[1])!;
      close(o[0], u, 1e-9); close(o[1], v, 1e-9);
    }
  });

  it('rotation: 90° turns move the corners where they should; every turn lands where it should', () => {
    const src = scene();
    const r1 = renderImage(src, W, H, P({ orientation: 1 }));
    expect([r1.width, r1.height]).toEqual([H, W]);
    expect(px(r1.data, H, H - 1, 0)).toEqual(px(src, W, 0, 0)); // source top-left -> output top-right (clockwise)
    expect(px(r1.data, H, 0, 0)).toEqual(px(src, W, 0, H - 1)); // source bottom-left -> output top-left
    const r2 = renderImage(src, W, H, P({ orientation: 2 }));
    expect(px(r2.data, W, W - 1, H - 1)).toEqual(px(src, W, 0, 0));
    const f = renderImage(src, W, H, P({ flipH: 1 }));
    expect(px(f.data, W, W - 1, 3)).toEqual(px(src, W, 0, 3));
    const v = renderImage(src, W, H, P({ flipV: 1 }));
    expect(px(v.data, W, 4, H - 1)).toEqual(px(src, W, 4, 0));
    // 270° clockwise (= 90° counter-clockwise): source top-left -> output bottom-left, bottom-right -> top-right
    const r3 = renderImage(src, W, H, P({ orientation: 3 }));
    expect(px(r3.data, H, 0, W - 1)).toEqual(px(src, W, 0, 0));
    expect(px(r3.data, H, H - 1, 0)).toEqual(px(src, W, W - 1, H - 1));
  });

  it('crop reads exactly the chosen pixels and never touches the original', () => {
    const src = scene(), copy = src.slice();
    const out = renderImage(src, W, H, P({ crop: { ...fullCrop(), x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }));
    expect([out.width, out.height]).toEqual([24, 18]);
    for (const [x, y] of [[0, 0], [5, 7], [23, 17], [12, 9]]) expect(px(out.data, 24, x, y)).toEqual(px(src, W, x + 12, y + 9));
    expect(Array.from(src)).toEqual(Array.from(copy));
    // removing the crop brings back the full, identical image
    const full = renderImage(src, W, H, P({ crop: fullCrop() }));
    expect(Array.from(full.data)).toEqual(Array.from(src));
  });

  it('heavy geometry + lens edits leave the source bytes untouched and are fully reversible', () => {
    const src = scene(), copy = src.slice();
    renderImage(src, W, H, P({ straighten: 12, geoVertical: 40, lensDistortion: 80, geoScale: 130, crop: { ...fullCrop(), x: 0.2, y: 0.2, w: 0.4, h: 0.4 } }));
    expect(Array.from(src)).toEqual(Array.from(copy));
    expect(Array.from(renderImage(src, W, H, DEFAULT_PARAMS).data)).toEqual(Array.from(copy));
  });

  it('straighten rotates by the requested angle; content outside the original is transparent', () => {
    const c = Math.cos((10 * Math.PI) / 180), s = Math.sin((10 * Math.PI) / 180);
    const m = geoMatrix(G({ straighten: 10 }), 300, 200);
    const pt = project(m, 100, 0)!; // clockwise on screen (y down): (100,0) -> (100cos, 100sin)
    close(pt[0], 100 * c, 1e-9); close(pt[1], 100 * s, 1e-9);
    const out = renderImage(scene(), W, H, P({ straighten: 10 }));
    expect(out.data[3]).toBe(0); // the top-left corner of the canvas now lies outside the rotated original
    expect(out.data[((H >> 1) * W + (W >> 1)) * 4 + 3]).toBe(255);
  });

  it('perspective: +Vertical widens the top and narrows the bottom; Horizontal does the same sideways', () => {
    const m = geoMatrix(G({ geoVertical: 50 }), 300, 200);
    const top = project(m, 150, -100)![0] - project(m, -150, -100)![0];
    const bottom = project(m, 150, 100)![0] - project(m, -150, 100)![0];
    expect(top).toBeGreaterThan(300); expect(bottom).toBeLessThan(300);
    const mh = geoMatrix(G({ geoHorizontal: 50 }), 300, 200);
    const left = project(mh, -150, 100)![1] - project(mh, -150, -100)![1];
    const right = project(mh, 150, 100)![1] - project(mh, 150, -100)![1];
    expect(left).not.toBeCloseTo(right, 1);
  });

  it('scale, offset and aspect behave as documented', () => {
    close(project(geoMatrix(G({ geoScale: 150 }), 300, 200), 100, 40)![0], 150, 1e-9);
    const t = project(geoMatrix(G({ geoOffsetX: 10, geoOffsetY: -20 }), 300, 200), 0, 0)!;
    close(t[0], 0.1 * 0.5 * 300, 1e-9); close(t[1], -0.2 * 0.5 * 200, 1e-9);
    const a = geoMatrix(G({ geoAspect: 100 }), 300, 200);
    close(a[0] * a[4], 1, 1e-9); // area preserving
    expect(a[0]).toBeGreaterThan(1);
  });

  it('output size follows the crop and respects a size limit', () => {
    expect(outputSize(P({ crop: { ...fullCrop(), w: 0.5, h: 0.25 } }), 1000, 800)).toEqual({ w: 500, h: 200 });
    expect(outputSize(P({ orientation: 1 }), 1000, 800)).toEqual({ w: 800, h: 1000 });
    expect(outputSize(DEFAULT_PARAMS, 4000, 3000, 1000)).toEqual({ w: 1000, h: 750 });
  });

  it('valid-area test: rotating the full frame exposes empty corners, and fitCropInside removes them', () => {
    const p = P({ straighten: 8 });
    const map = makeGeoMap(p, 300, 200);
    expect(rectInsideSource(map, { x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    const fit = fitCropInside(fullCrop(), (r) => rectInsideSource(map, r));
    expect(rectInsideSource(map, fit)).toBe(true);
    expect(fit.w).toBeLessThan(1);
    close((fit.x + fit.w / 2), 0.5, 1e-6); close(fit.w * 300 / (fit.h * 200), 300 / 200, 1e-6); // same centre, same aspect
    // and it is the LARGEST such rectangle (slightly bigger is invalid)
    const bigger = { x: 0.5 - (fit.w * 1.02) / 2, y: 0.5 - (fit.h * 1.02) / 2, w: fit.w * 1.02, h: fit.h * 1.02 };
    expect(rectInsideSource(map, bigger)).toBe(false);
  });
});

describe('crop tool logic', () => {
  it('aspect presets give the right pixel ratios', () => {
    const r = (aspect: Crop['aspect'], portrait = false, cw = 1, ch = 1) => presetRatio({ aspect, portrait, customW: cw, customH: ch }, 1.5);
    expect(r('free')).toBeNull();
    expect(r('original')).toBe(1.5);
    expect(r('1:1')).toBe(1);
    expect(r('4:5')).toBeCloseTo(0.8); expect(r('4:5', true)).toBeCloseTo(1.25);
    expect(r('3:2')).toBeCloseTo(1.5); expect(r('3:2', true)).toBeCloseTo(2 / 3);
    expect(r('4:3')).toBeCloseTo(4 / 3); expect(r('16:9')).toBeCloseTo(16 / 9);
    expect(r('custom', false, 7, 5)).toBeCloseTo(1.4);
    expect(ASPECT_PRESETS.map((a) => a.id)).toEqual(['original', 'custom', 'free', '1:1', '4:5', '5:7', '2:3', '3:4', '16:9', '3:2', '4:3']);
  });

  it('fitRatio returns the largest centred rectangle of the ratio inside the crop', () => {
    const cv = { w: 3000, h: 2000 };
    for (const ratio of [1, 0.8, 16 / 9, 1.5]) {
      const c = fitRatio(fullCrop(), ratio, cv);
      close((c.w * cv.w) / (c.h * cv.h), ratio, 1e-9);
      expect(c.w <= 1 + 1e-12 && c.h <= 1 + 1e-12).toBe(true);
      expect(c.w === 1 || Math.abs(c.h - 1) < 1e-12).toBe(true); // touches at least one edge
      close(c.x + c.w / 2, 0.5, 1e-12); close(c.y + c.h / 2, 0.5, 1e-12);
    }
  });

  it('dragging: move is clamped, free edges/corners resize, minimum size holds', () => {
    const cv = { w: 1000, h: 1000 };
    const start: Crop = { ...fullCrop(), x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    let c = dragCrop(start, 'move', 0.9, -0.9, null, cv);
    expect(c.x + c.w).toBeCloseTo(1); expect(c.y).toBe(0); expect(c.w).toBe(0.4);
    c = dragCrop(start, 'e', 0.1, 0, null, cv);
    expect(c.w).toBeCloseTo(0.5); expect(c.x).toBe(0.2);
    c = dragCrop(start, 'nw', -0.1, -0.05, null, cv);
    expect(c.x).toBeCloseTo(0.1); expect(c.y).toBeCloseTo(0.15); expect(c.x + c.w).toBeCloseTo(0.6);
    c = dragCrop(start, 'w', 5, 0, null, cv); // can't invert the rectangle
    expect(c.w).toBeGreaterThan(0); expect(c.x + c.w).toBeCloseTo(0.6);
  });

  it('dragging with a locked ratio keeps the ratio exactly, anchored correctly', () => {
    const cv = { w: 3000, h: 2000 };
    const ratio = 1.5;
    const start = fitRatio({ ...fullCrop(), x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, ratio, cv);
    for (const handle of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as const) {
      for (const [dx, dy] of [[0.05, 0.03], [-0.04, -0.06], [0.2, 0.2], [-0.3, 0.1]]) {
        const c = dragCrop(start, handle, dx, dy, ratio, cv);
        close((c.w * cv.w) / (c.h * cv.h), ratio, 1e-6);
        expect(c.x).toBeGreaterThanOrEqual(-1e-9); expect(c.y).toBeGreaterThanOrEqual(-1e-9);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9); expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    const se = dragCrop(start, 'se', 0.05, 0.05, ratio, cv); // the opposite (top-left) corner stays put
    close(se.x, start.x, 1e-9); close(se.y, start.y, 1e-9);
  });

  it('normalizeCrop repairs bad input; a full crop is recognised', () => {
    expect(isFullCrop(FULL_CROP)).toBe(true);
    const c = normalizeCrop({ x: -3, y: 0.9, w: 5, h: 0.5, aspect: 'nonsense' });
    expect(c.x).toBe(0); expect(c.w).toBe(1); expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-12); expect(c.aspect).toBe('free');
    expect(normalizeCrop(null)).toEqual(fullCrop());
    expect(normalizeParams({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }).crop.w).toBe(0.5);
  });
});

describe('lens corrections', () => {
  /** Image whose encoded value is the normalised radius (r / half-diagonal) in every channel. */
  const radial = (w: number, h: number) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / Math.hypot(w / 2, h / 2);
      a.set([r * 200, r * 200, r * 200, 255], (y * w + x) * 4);
    }
    return a;
  };

  it('distortion: corrects barrel (+) by reading inside the frame at the edges, pincushion (−) by reading outside; centre is fixed', () => {
    const w = 64, h = 48, src = radial(w, h);
    const base = renderImage(src, w, h, DEFAULT_PARAMS).data;
    const barrel = renderImage(src, w, h, P({ lensDistortion: 80 })).data;
    const pin = renderImage(src, w, h, P({ lensDistortion: -40 })).data;
    const corner = (d: Uint8ClampedArray) => px(d, w, 2, 2)[0];
    const centre = (d: Uint8ClampedArray) => px(d, w, w / 2, h / 2)[0];
    expect(corner(barrel)).toBeLessThan(corner(base) - 10); // smaller source radius read at the corner
    expect(barrel.length).toBe(base.length);
    expect(Math.abs(centre(barrel) - centre(base))).toBeLessThanOrEqual(2);
    expect(pin[3]).toBe(0); // pincushion correction reads beyond the original at the corners: transparent, not smeared
    expect(Math.abs(centre(pin) - centre(base))).toBeLessThanOrEqual(2);
  });

  it('distortion is radially symmetric', () => {
    const d = derive(P({ lensDistortion: 60 }), 100, 100);
    const a = sampleSource(scene(100, 100), d, 80, 50), b = sampleSource(scene(100, 100), d, 50, 80);
    close(a.rc2, b.rc2, 1e-9);
  });

  it('vignetting correction brightens corners only; negative darkens them', () => {
    const w = 60, h = 40, flat = new Uint8ClampedArray(w * h * 4).fill(120);
    for (let i = 3; i < flat.length; i += 4) flat[i] = 255;
    const up = renderImage(flat, w, h, P({ lensVignetting: 80 })).data, dn = renderImage(flat, w, h, P({ lensVignetting: -80 })).data;
    expect(px(up, w, 0, 0)[0]).toBeGreaterThan(px(flat, w, 0, 0)[0] + 25);
    expect(Math.abs(px(up, w, w / 2, h / 2)[0] - 120)).toBeLessThanOrEqual(2);
    expect(px(dn, w, 0, 0)[0]).toBeLessThan(120 - 25);
  });

  it('chromatic aberration shifts red and blue radially and leaves green alone', () => {
    const w = 600, h = 40, src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round(128 + 100 * Math.sin(x * 0.8)); src.set([v, v, v, 255], (y * w + x) * 4); }
    const out = renderImage(src, w, h, P({ lensCA: 100 })).data;
    let maxR = 0, maxG = 0, maxB = 0, centre = 0;
    for (let x = w - 80; x < w - 2; x++) {
      const o = px(out, w, x, 20), r = px(src, w, x, 20);
      maxR = Math.max(maxR, Math.abs(o[0] - r[0])); maxG = Math.max(maxG, Math.abs(o[1] - r[1])); maxB = Math.max(maxB, Math.abs(o[2] - r[2]));
    }
    for (let x = w / 2 - 3; x < w / 2 + 3; x++) centre = Math.max(centre, Math.abs(px(out, w, x, 20)[0] - px(src, w, x, 20)[0]));
    expect(maxG).toBe(0); // green is the reference channel
    expect(maxR).toBeGreaterThan(20); expect(maxB).toBeGreaterThan(20); // red/blue displaced at the edge
    expect(centre).toBeLessThanOrEqual(2); // nothing at the optical centre
    const o = px(out, w, w - 40, 20), r = px(src, w, w - 40, 20);
    expect(o[0] !== r[0] && o[2] !== r[2] && o[0] !== o[2]).toBe(true); // red and blue go opposite ways
  });

  it('profiles: registry, effective amounts (profile + manual), clearly-labelled examples, custom registration', () => {
    expect(getLensProfile('none')).toBeNull();
    expect(listLensProfiles().filter((p) => p.example).length).toBeGreaterThanOrEqual(2);
    const e = effectiveLens('example-wide', { distortion: 10, vignetting: 0, chromaticAberration: -5 });
    expect(e.distortion).toBe(getLensProfile('example-wide')!.distortion + 10);
    expect(effectiveLens('none', { distortion: 500, vignetting: -500, chromaticAberration: 0 })).toEqual({ distortion: 100, vignetting: -100, chromaticAberration: 0 });
    registerLensProfile({ id: 'test-lens', name: 'Test lens', distortion: 20, vignetting: 40, chromaticAberration: 0 });
    const d = derive(P({ lensProfile: 'test-lens', lensVignetting: 10 }), 10, 10);
    expect(d.lens.vig).toBeCloseTo(0.5);
    expect(d.active.lens).toBe(true);
    expect(derive(DEFAULT_PARAMS, 10, 10).active.lens).toBe(false);
  });
});

describe('automatic perspective (upright)', () => {
  /** Edge samples of ideal vertical + horizontal lines, then distorted by the INVERSE of the truth. */
  function distortedLines(truth: GeoParams, sw = 600, sh = 400): EdgeSample[] {
    const inv = inv3(geoMatrix(truth, sw, sh));
    const out: EdgeSample[] = [];
    const add = (x: number, y: number, dx: number, dy: number) => {
      const u = inv[0] * x + inv[1] * y + inv[2], v = inv[3] * x + inv[4] * y + inv[5], w = inv[6] * x + inv[7] * y + inv[8];
      const w2 = w * w;
      const ddx = ((inv[0] * w - u * inv[6]) * dx + (inv[1] * w - u * inv[7]) * dy) / w2;
      const ddy = ((inv[3] * w - v * inv[6]) * dx + (inv[4] * w - v * inv[7]) * dy) / w2;
      const n = Math.hypot(ddx, ddy);
      out.push({ x: u / w, y: v / w, dx: ddx / n, dy: ddy / n, w: 1 });
    };
    for (let i = 0; i < 14; i++) for (let k = 0; k < 40; k++) {
      add(-270 + i * 40, -180 + k * 9, 0, 1); // vertical lines
      if (i < 10) add(-270 + k * 13, -150 + i * 32, 1, 0); // horizontal lines
    }
    return out;
  }

  it('recovers a known vertical keystone and tilt, and the correction makes lines straight', () => {
    const truth = G({ geoVertical: 28, straighten: 2.5 });
    const s = distortedLines(truth);
    const est = estimateUpright(s, 600, 400, DEFAULT_GEO, 'auto')!;
    expect(est).not.toBeNull();
    expect(Math.abs(est.geoVertical! - 28)).toBeLessThan(4);
    expect(Math.abs(est.straighten! - 2.5)).toBeLessThan(0.4);
  });

  it('level only fixes rotation; vertical only fixes keystone; full also fixes horizontal perspective', () => {
    const lvl = estimateUpright(distortedLines(G({ straighten: -3 })), 600, 400, DEFAULT_GEO, 'level')!;
    expect(Object.keys(lvl)).toEqual(['straighten']); expect(Math.abs(lvl.straighten! + 3)).toBeLessThan(0.3);
    const vert = estimateUpright(distortedLines(G({ geoVertical: -22 })), 600, 400, DEFAULT_GEO, 'vertical')!;
    expect(Object.keys(vert)).toEqual(['geoVertical']); expect(Math.abs(vert.geoVertical! + 22)).toBeLessThan(4);
    const full = estimateUpright(distortedLines(G({ geoVertical: 15, geoHorizontal: -20, straighten: 1.5 })), 600, 400, DEFAULT_GEO, 'full')!;
    expect(Math.abs(full.geoHorizontal! + 20)).toBeLessThan(5); expect(Math.abs(full.geoVertical! - 15)).toBeLessThan(5);
  });

  it('finds nothing (returns null) when there are no straight lines; never invents a correction', () => {
    expect(estimateUpright([], 600, 400, DEFAULT_GEO, 'auto')).toBeNull();
    const rnd: EdgeSample[] = [];
    for (let i = 0; i < 400; i++) { const a = Math.sin(i * 12.9898) * 43758.5453; const t = (a - Math.floor(a)) * Math.PI; rnd.push({ x: (i % 20) * 10 - 100, y: Math.floor(i / 20) * 10 - 100, dx: Math.cos(t), dy: Math.sin(t), w: 1 }); }
    expect(estimateUpright(rnd, 600, 400, DEFAULT_GEO, 'auto')).toBeNull();
  });

  it('edge detection on a real raster: slightly tilted smooth stripes are levelled', () => {
    for (const hard of [false]) {
      const w = 120, h = 90, theta = (3 * Math.PI) / 180, rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = (x - w / 2) * Math.cos(theta) + (y - h / 2) * Math.sin(theta);
        const sn = Math.sin((2 * Math.PI * t) / 14);
        const v = hard ? (sn > 0 ? 220 : 40) : 130 + 90 * sn; // edges tilted 3° from vertical
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
      const s = edgeSamples(grayFromRgba(rgba, w, h), w, h);
      expect(s.length).toBeGreaterThan(200);
      const est = estimateUpright(s, w, h, DEFAULT_GEO, 'level')!;
      expect(est, hard ? 'hard-edged' : 'smooth').not.toBeNull();
      expect(Math.abs(Math.abs(est.straighten!) - 3)).toBeLessThan(0.6);
    }
  });
});

describe('masks stay attached to the picture', () => {
  it('a mask placed on image content follows it through crop, rotate and straighten', async () => {
    const { newMask, newShape, spanOf } = await import('../src/masks/types');
    const span = spanOf(W, H);
    const shape = { ...newShape('radial', span), cx: 0.15, cy: 0, rx: 0.12, ry: 0.12, feather: 10 } as ReturnType<typeof newShape>;
    const mask = { ...newMask(shape, 'M'), adjust: { exposure: -2 } };
    const src = scene();
    const full = renderImage(src, W, H, P({ masks: [mask] }));
    const cropped = renderImage(src, W, H, P({ masks: [mask], crop: { ...fullCrop(), x: 0.5, y: 0, w: 0.5, h: 1 } }));
    // output pixel (x, y) of the cropped image IS source pixel (x + 24, y): values must match the full render there
    for (const [x, y] of [[0, 10], [6, 18], [10, 17], [20, 30], [23, 5]]) expect(px(cropped.data, 24, x, y)).toEqual(px(full.data, W, x + 24, y));
    // and the darkened area exists (mask really applied) and is not everywhere
    const plain = renderImage(src, W, H, DEFAULT_PARAMS);
    let darker = 0; for (let i = 0; i < full.data.length; i += 4) if (full.data[i] < plain.data[i] - 10) darker++;
    expect(darker).toBeGreaterThan(20); expect(darker).toBeLessThan(W * H * 0.4);
    // 90° rotation: the masked region moves with the image
    const rot = renderImage(src, W, H, P({ masks: [mask], orientation: 1 }));
    const plainRot = renderImage(src, W, H, P({ orientation: 1 }));
    let darkRot = 0; for (let i = 0; i < rot.data.length; i += 4) if (rot.data[i] < plainRot.data[i] - 10) darkRot++;
    expect(darkRot).toBe(darker);
  });

  it('range masks look at the original colour, so global edits never move the selection', () => {
    const d1 = derive(P({}), W, H), d2 = derive(P({ exposure: 3, saturation: 80 }), W, H);
    const src = scene();
    const a = sampleSource(src, d1, 10, 10), b = sampleSource(src, d2, 10, 10);
    expect(a.c0).toEqual(b.c0);
    close(a.c0[0], srgbToLinear(px(src, W, 10, H - 1 - 10)[0] / 255), 1e-9);
  });
});

import { constrainCrop, cropIsValid, flip, resetCropTool, rotate90, setAspect, swapAspectOrientation } from '../src/geometry/cropActions';
import { previewPatch, setParams, resetSection, commitParam, previewParam } from '../src/history/editActions';
import { createHistory, present, undo } from '../src/history/history';

describe('crop actions (what the Crop tool does)', () => {
  const cropped = P({ crop: { ...fullCrop(), x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
  const mirrorX = (d: Uint8ClampedArray, w: number, h: number) => { const o = new Uint8ClampedArray(d.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.set(d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (y * w + (w - 1 - x)) * 4); return o; };

  it('rotating turns the crop with the picture: the same pixels, rotated', () => {
    const src = scene();
    const r0 = renderImage(src, W, H, cropped);
    const r1 = renderImage(src, W, H, rotate90(cropped, 1));
    expect([r1.width, r1.height]).toEqual([r0.height, r0.width]);
    expect(px(r1.data, r0.height, r0.height - 1, 0)).toEqual(px(r0.data, r0.width, 0, 0)); // TL -> TR
    expect(px(r1.data, r0.height, 0, r0.width - 1)).toEqual(px(r0.data, r0.width, r0.width - 1, r0.height - 1)); // BR -> BL
    const left = rotate90(cropped, -1), back = rotate90(left, 1);
    expect(back.orientation).toBe(0);
    for (const k of ['x', 'y', 'w', 'h'] as const) close(back.crop[k], cropped.crop[k], 1e-12);
    // four quarter turns come home
    let q = cropped; for (let i = 0; i < 4; i++) q = rotate90(q, 1);
    expect(q.orientation).toBe(0); close(q.crop.x, cropped.crop.x, 1e-12); close(q.crop.w, cropped.crop.w, 1e-12);
  });

  it('flip mirrors the picture on screen and the crop with it, also on a quarter-turned canvas', () => {
    const src = scene();
    const base = renderImage(src, W, H, cropped);
    const f = renderImage(src, W, H, flip(cropped, 'h'));
    expect(Array.from(f.data)).toEqual(Array.from(mirrorX(base.data, base.width, base.height)));
    const turned = rotate90(cropped, 1);
    const tb = renderImage(src, W, H, turned), tf = renderImage(src, W, H, flip(turned, 'h'));
    expect(Array.from(tf.data)).toEqual(Array.from(mirrorX(tb.data, tb.width, tb.height))); // still a SCREEN-horizontal mirror
    const twice = flip(flip(cropped, 'v'), 'v');
    expect(twice.flipV).toBe(0); close(twice.crop.y, cropped.crop.y, 1e-12); close(twice.crop.h, cropped.crop.h, 1e-12);
  });

  it('aspect presets re-fit the crop to the exact pixel ratio and keep it inside the picture', () => {
    const aspect = W / H;
    const sq = setAspect(DEFAULT_PARAMS, '1:1', aspect);
    const out = renderImage(scene(), W, H, sq);
    expect(out.width).toBe(out.height);
    const r = setAspect(setAspect(DEFAULT_PARAMS, '16:9', aspect), '4:5', aspect);
    close((r.crop.w * W) / (r.crop.h * H), 0.8, 1e-9);
    const sw = swapAspectOrientation(r, aspect);
    close((sw.crop.w * W) / (sw.crop.h * H), 1.25, 1e-9);
    const custom = setAspect(DEFAULT_PARAMS, 'custom', aspect, { w: 7, h: 5 });
    close((custom.crop.w * W) / (custom.crop.h * H), 1.4, 1e-9);
    expect(setAspect(r, 'free', aspect).crop).toEqual({ ...r.crop, aspect: 'free' }); // unlocking changes nothing else
    const rotated = setAspect(P({ straighten: 8 }), '1:1', aspect);
    expect(cropIsValid(rotated, aspect)).toBe(true); // a preset never reads outside a rotated picture
  });

  it('geometry edits keep the crop valid automatically, in one undoable step', () => {
    const aspect = 1.5;
    let h = createHistory(DEFAULT_PARAMS);
    h = previewPatch(h, { straighten: 7 }, { aspect });
    expect(present(h).crop.w).toBeLessThan(1);
    expect(cropIsValid(present(h), aspect)).toBe(true);
    h = previewPatch(h, { straighten: 14 }, { aspect });
    const c14 = present(h).crop.w; expect(c14).toBeLessThan(present(createHistory(h.live ?? DEFAULT_PARAMS)).crop.w + 1e-9);
    h = commitParam(h, 'straighten');
    expect(h.entries.length).toBe(2);
    h = undo(h);
    expect(present(h).straighten).toBe(0); expect(present(h).crop).toEqual(fullCrop());
    // without context (e.g. tests, scripts) nothing is constrained
    expect(present(setParams(createHistory(DEFAULT_PARAMS), { straighten: 7 }, 'x')).crop).toEqual(fullCrop());
    const n = constrainCrop(P({ straighten: 7 }), DEFAULT_PARAMS, aspect);
    expect(n.crop.w).toBeLessThan(1);
    expect(constrainCrop(P({ exposure: 1 }), DEFAULT_PARAMS, aspect).crop).toBe(DEFAULT_PARAMS.crop); // non-geometry edits don't touch the crop
  });

  it('resets: the crop tool resets rectangle, orientation, flips and angle; section reset matches', () => {
    let p = rotate90(flip(setAspect(P({ straighten: 5 }), '3:2', 1.5), 'h'), 1);
    p = resetCropTool(p);
    expect(p.orientation).toBe(0); expect(p.flipH + p.flipV).toBe(0); expect(p.straighten).toBe(0); expect(p.crop).toEqual(fullCrop());
    let h = createHistory(rotate90(P({ straighten: 5 }), 1));
    h = resetSection(h, 'crop');
    expect(present(h).orientation).toBe(0); expect(present(h).straighten).toBe(0);
    h = previewParam(createHistory(DEFAULT_PARAMS), 'geoScale', 60, { aspect: 1.5 });
    expect(present(h).crop.w).toBeLessThan(1); // zooming out exposes empty canvas, so the crop follows
  });
});

import { straightenFromLine } from '../src/geometry/cropActions';

describe('straighten tool (draw a line)', () => {
  /** Screen angle (degrees, CW positive) of the line p→q after the geometry matrix for straighten `s`. */
  const angleAfter = (s: number, phi: number) => {
    const M = geoMatrix({ ...DEFAULT_GEO, straighten: s }, 600, 400);
    const a = project(M, 0, 0)!, b = project(M, 100 * Math.cos((phi * Math.PI) / 180), 100 * Math.sin((phi * Math.PI) / 180))!;
    return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  };
  it('the angle it returns really makes the drawn line level under the real transform', () => {
    for (const phi of [7, -12.5, 30, -44, 0.4]) {
      const cur = 0; // picture as displayed now: line sits at phi
      const dx = Math.cos((phi * Math.PI) / 180) * 200, dy = Math.sin((phi * Math.PI) / 180) * 200;
      const s = straightenFromLine(cur, 10, 10, 10 + dx, 10 + dy)!;
      expect(Math.abs(angleAfter(s, phi))).toBeLessThan(0.05);
    }
  });
  it('accounts for the angle already applied, and for lines drawn right-to-left', () => {
    const s0 = 3, phi = 5 + s0; // the line's angle on the displayed (already straightened) picture
    const dx = Math.cos((phi * Math.PI) / 180) * 150, dy = Math.sin((phi * Math.PI) / 180) * 150;
    expect(straightenFromLine(s0, 300, 300, 300 - dx, 300 - dy)).toBeCloseTo(-5, 1); // total angle that levels the ORIGINAL line
  });
  it('near-vertical lines are made plumb; too-short lines and huge tilts are handled', () => {
    expect(Math.abs(straightenFromLine(0, 10, 10, 13, 210)! - (-((Math.atan2(200, 3) * 180) / Math.PI - 90)))).toBeLessThan(0.02);
    expect(straightenFromLine(0, 5, 5, 8, 6)).toBeNull();
    expect(Math.abs(straightenFromLine(40, 0, 0, 100, -100)!)).toBeLessThanOrEqual(45);
  });
});

describe('aspect presets', () => {
  it('offers the Lightroom-style list and keeps the older presets', () => {
    const ids = ASPECT_PRESETS.map((a) => a.id);
    for (const id of ['original', 'custom', 'free', '1:1', '4:5', '5:7', '2:3', '3:4', '16:9', '3:2', '4:3']) expect(ids).toContain(id);
  });
  it('portrait presets are portrait by default and flip with orientation', () => {
    const r = (aspect: '5:7' | '2:3' | '3:4' | '3:2', portrait = false) => presetRatio({ aspect, customW: 1, customH: 1, portrait }, 1.5)!;
    expect(r('5:7')).toBeCloseTo(5 / 7); expect(r('2:3')).toBeCloseTo(2 / 3); expect(r('3:4')).toBeCloseTo(3 / 4); expect(r('3:2')).toBeCloseTo(1.5);
    expect(r('5:7', true)).toBeCloseTo(7 / 5); expect(r('3:2', true)).toBeCloseTo(2 / 3);
  });
});
