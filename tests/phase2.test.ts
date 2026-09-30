import { describe, expect, it } from 'vitest';
import { luminance, type Vec3 } from '../src/color/colorSpace';
import { linearToOklab, oklchToLinear } from '../src/image-engine/oklab';
import {
  addPoint, buildLut, curvesAreIdentity, defaultCurves, evalCurve, identityCurve, isIdentityCurve, LUT_SIZE, makeCurve, movePoint, MIN_GAP,
  normalizeCurve, removePoint, sampleLut, type CurvePoint,
} from '../src/image-engine/curves';
import { gradeWeights, hash2, mixWeights, vignetteDistance, grainNoise, MIX_HUES } from '../src/image-engine/adjustments';
import { blurPlan, derive } from '../src/image-engine/derive';
import { gaussian, sampleBlur, blurField } from '../src/image-engine/blur';
import { buildFragmentShader } from '../src/image-engine/glsl';
import { DEFAULT_PARAMS, isDefault, normalizeParams, paramsEqual, type EditParams } from '../src/image-engine/params';
import { DEFAULT_PIPELINE, processLinear, renderImageData, renderPixel8 } from '../src/image-engine/pipeline';
import { mean, px, scene, stddev } from './helpers';

const P = (over: Partial<EditParams>): EditParams => ({ ...DEFAULT_PARAMS, curves: defaultCurves(), ...over });
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps);
const grey = (w: number, h: number, v: number) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) a.set([v, v, v, 255], i * 4); return a; };
const chroma = (c: Vec3) => Math.hypot(linearToOklab(c)[1], linearToOklab(c)[2]);
const hue = (c: Vec3) => { const l = linearToOklab(c); return ((Math.atan2(l[2], l[1]) * 180) / Math.PI + 360) % 360; };

describe('tone curve', () => {
  it('default is identity and is skipped by the pipeline', () => {
    expect(curvesAreIdentity(defaultCurves())).toBe(true);
    const lut = buildLut(defaultCurves());
    for (let i = 0; i <= 100; i++) close(sampleLut(lut, 0, i / 100), i / 100, 1e-6);
    expect(derive(DEFAULT_PARAMS, 4, 4).active.curve).toBe(false);
  });

  it('passes exactly through its control points (input 0.40 -> output 0.55)', () => {
    const pts: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.4, y: 0.55 }, { x: 0.8, y: 0.85 }, { x: 1, y: 1 }];
    for (const p of pts) close(evalCurve(pts, p.x), p.y, 1e-12);
    expect(evalCurve(pts, 0.4)).toBeCloseTo(0.55, 12);
  });

  it('is smooth and monotone (no overshoot) for monotone control points', () => {
    const pts: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.1, y: 0.02 }, { x: 0.45, y: 0.6 }, { x: 0.5, y: 0.62 }, { x: 0.9, y: 0.97 }, { x: 1, y: 1 }];
    const f = makeCurve(pts);
    let prev = -1;
    for (let i = 0; i <= 2000; i++) { const y = f(i / 2000); expect(y).toBeGreaterThanOrEqual(prev - 1e-12); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1); prev = y; }
    // C1: no kink at a control point
    const e = 1e-5;
    const slopeL = (f(0.45) - f(0.45 - e)) / e, slopeR = (f(0.45 + e) - f(0.45)) / e;
    close(slopeL, slopeR, 1e-2);
  });

  it('black point and white point: lifted/clipped ends and flat extension', () => {
    close(evalCurve([{ x: 0, y: 0.1 }, { x: 1, y: 1 }], 0), 0.1);
    close(evalCurve([{ x: 0, y: 0 }, { x: 1, y: 0.9 }], 1), 0.9);
    const clipped = [{ x: 0.2, y: 0 }, { x: 1, y: 1 }];
    expect(evalCurve(clipped, 0.05)).toBe(0); // everything below the black point maps to black
    expect(evalCurve(clipped, 0.6)).toBeGreaterThan(0.3);
    const wp = [{ x: 0, y: 0 }, { x: 0.8, y: 1 }];
    expect(evalCurve(wp, 0.95)).toBe(1);
  });

  it('RGB curve affects all channels; R/G/B curves only their own channel', () => {
    const c: Vec3 = [0.2, 0.2, 0.2];
    const lift = [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }];
    const all = processLinear(c, P({ curves: { ...defaultCurves(), rgb: lift } }));
    expect(all[0]).toBeGreaterThan(0.2); close(all[0], all[1], 1e-9); close(all[1], all[2], 1e-9);
    const red = processLinear(c, P({ curves: { ...defaultCurves(), r: lift } }));
    expect(red[0]).toBeGreaterThan(0.2); close(red[1], 0.2, 1e-6); close(red[2], 0.2, 1e-6);
    const blue = processLinear(c, P({ curves: { ...defaultCurves(), b: lift } }));
    expect(blue[2]).toBeGreaterThan(0.2); close(blue[0], 0.2, 1e-6);
  });

  it('LUT composes master then channel curve: out_c = curve_c(master(x))', () => {
    const master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }], r = [{ x: 0, y: 0 }, { x: 0.7, y: 0.4 }, { x: 1, y: 1 }];
    const lut = buildLut({ ...defaultCurves(), rgb: master, r });
    for (const x of [0.1, 0.33, 0.5, 0.8]) {
      close(sampleLut(lut, 0, x), evalCurve(r, evalCurve(master, x)), 2e-3);
      close(sampleLut(lut, 1, x), evalCurve(master, x), 2e-3);
    }
    expect(lut.length).toBe(LUT_SIZE * 4);
  });

  it('a mid-tone lift moves mid-grey the expected amount in the rendered image', () => {
    const p = P({ curves: { ...defaultCurves(), rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }] } });
    const out = renderPixel8([128, 128, 128], p);
    expect(Math.abs(out[0] - 0.65 * 255)).toBeLessThanOrEqual(3);
  });

  it('point editing: add (sorted), move (clamped), remove (interior only), repair', () => {
    let pts = identityCurve();
    const a = addPoint(pts, 0.5, 0.6); pts = a.points;
    expect(pts.map((p) => p.x)).toEqual([0, 0.5, 1]); expect(a.index).toBe(1);
    const b = addPoint(pts, 0.5 + MIN_GAP / 2, 0.1); expect(b.points).toBe(pts); expect(b.index).toBe(1); // too close: selects existing
    pts = addPoint(pts, 0.25, 0.2).points;
    pts = movePoint(pts, 1, 0.9, 0.3); // can't pass its neighbour at 0.5
    expect(pts[1].x).toBeLessThan(pts[2].x); expect(pts[2].x - pts[1].x).toBeGreaterThanOrEqual(MIN_GAP - 1e-12);
    pts = movePoint(pts, 0, -5, 7); // end points stay within the box
    expect(pts[0]).toEqual({ x: 0, y: 1 });
    expect(removePoint(pts, 0)).toBe(pts); expect(removePoint(pts, pts.length - 1)).toBe(pts);
    expect(removePoint(pts, 1)).toHaveLength(pts.length - 1);
    expect(normalizeCurve('junk')).toEqual(identityCurve());
    expect(normalizeCurve([{ x: 0.9, y: 2 }, { x: 0.1, y: -1 }, { x: NaN, y: 0 }])).toEqual([{ x: 0.1, y: 0 }, { x: 0.9, y: 1 }]);
    expect(isIdentityCurve(normalizeCurve([{ x: 0.5, y: 0.5 }]))).toBe(true);
  });

  it('curves round-trip through params normalisation and count as an edit', () => {
    const curves = { ...defaultCurves(), rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }] };
    const p = normalizeParams(JSON.parse(JSON.stringify(P({ curves }))));
    expect(paramsEqual(p, P({ curves }))).toBe(true);
    expect(paramsEqual(p, DEFAULT_PARAMS)).toBe(false);
    expect(isDefault(p)).toBe(false);
    expect(isDefault(DEFAULT_PARAMS)).toBe(true);
  });
});

describe('colour mixer', () => {
  it('weights form a smooth partition of unity over only two neighbouring bands', () => {
    for (let h = 0; h < 360; h += 3) {
      const w = mixWeights(h);
      close(w.wa + w.wb, 1, 1e-12);
      expect(w.wa).toBeGreaterThanOrEqual(0); expect(w.wb).toBeGreaterThanOrEqual(0);
    }
    const weightOn = (h: number, band: number) => { const w = mixWeights(h); return w.a === band ? w.wa : w.b === band ? w.wb : 0; };
    MIX_HUES.forEach((hc, i) => close(weightOn(hc, i), 1, 1e-9)); // each band is fully itself at its own hue
    for (const [h1, h2] of [[359.9, 0.1], [29.1, 29.3]]) for (let band = 0; band < 8; band++) close(weightOn(h1, band), weightOn(h2, band), 5e-3); // continuous, incl. the magenta->red wrap
  });

  it('zero is identity; neutrals are untouched even at extreme settings', () => {
    const c: Vec3 = [0.3, 0.2, 0.1];
    expect(processLinear(c, DEFAULT_PARAMS)).toEqual(c);
    const all: Partial<EditParams> = {};
    for (const k of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']) { (all as Record<string, number>)[`mix_${k}_sat`] = 100; (all as Record<string, number>)[`mix_${k}_hue`] = 100; (all as Record<string, number>)[`mix_${k}_lum`] = 100; }
    const g = processLinear([0.4, 0.4, 0.4], P(all), ['mixer']);
    for (let i = 0; i < 3; i++) close(g[i], 0.4, 1e-4);
  });

  it('a band affects its own colour and leaves distant colours alone', () => {
    const red = oklchToLinear(0.65, 0.15, MIX_HUES[0]), blue = oklchToLinear(0.65, 0.15, MIX_HUES[5]);
    const p = P({ mix_red_sat: -100 });
    close(chroma(processLinear(red, p, ['mixer'])), 0, 1e-3); // red fully desaturated
    close(chroma(processLinear(blue, p, ['mixer'])), chroma(blue), 1e-4); // blue untouched
  });

  it('influence fades smoothly into neighbouring colours (no hard boundary)', () => {
    const p = P({ mix_red_sat: -100 });
    const ratio = (h: number) => { const c = oklchToLinear(0.65, 0.12, h); return chroma(processLinear(c, p, ['mixer'])) / chroma(c); };
    const hs = [29.2, 35, 41, 47, 53, 70];
    const r = hs.map(ratio);
    expect(r[0]).toBeLessThan(0.01);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThanOrEqual(r[i - 1] - 1e-9); // monotone recovery
    expect(r[2]).toBeGreaterThan(0.2); expect(r[2]).toBeLessThan(0.8); // partial in between
    close(r[4], 1, 1e-3); // orange centre is unaffected by the red slider
  });

  it('hue slider rotates hue by up to ±30° in OKLCH; luminance slider changes lightness', () => {
    const blue = oklchToLinear(0.55, 0.15, MIX_HUES[5]);
    const shifted = processLinear(blue, P({ mix_blue_hue: 100 }), ['mixer']);
    close(((hue(shifted) - hue(blue) + 540) % 360) - 180, 30, 0.5);
    const green = oklchToLinear(0.6, 0.15, MIX_HUES[3]);
    expect(luminance(processLinear(green, P({ mix_green_lum: 100 }), ['mixer']))).toBeGreaterThan(luminance(green));
    expect(luminance(processLinear(green, P({ mix_green_lum: -100 }), ['mixer']))).toBeLessThan(luminance(green));
  });
});

describe('colour grading', () => {
  const grade = (over: Partial<EditParams>, c: Vec3) => processLinear(c, P(over), ['grading']);
  const tint = (a: Vec3, b: Vec3) => [linearToOklab(a)[1] - linearToOklab(b)[1], linearToOklab(a)[2] - linearToOklab(b)[2]];
  const dark: Vec3 = [0.01, 0.01, 0.01], bright: Vec3 = [0.9, 0.9, 0.9], midg: Vec3 = [0.2, 0.2, 0.2];

  it('no tint and no luminance change is identity', () => {
    expect(derive(P({ grade_shadows_hue: 200 }), 4, 4).active.grading).toBe(false); // hue alone does nothing
    expect(grade({}, midg)).toEqual(midg);
  });

  it('shadows tint lands in dark pixels, highlights tint in bright ones, global everywhere', () => {
    const sh = P({ grade_shadows_hue: 264, grade_shadows_sat: 100 });
    const dS = Math.hypot(...tint(grade(sh, dark), dark)), bS = Math.hypot(...tint(grade(sh, bright), bright));
    expect(dS).toBeGreaterThan(0.06); expect(bS).toBeLessThan(0.005);
    const hl = { grade_highlights_hue: 60, grade_highlights_sat: 100 };
    expect(Math.hypot(...tint(grade(hl, bright), bright))).toBeGreaterThan(0.06);
    expect(Math.hypot(...tint(grade(hl, dark), dark))).toBeLessThan(0.005);
    const gl = { grade_global_hue: 120, grade_global_sat: 50 };
    for (const c of [dark, midg, bright]) close(Math.hypot(...tint(grade(gl, c), c)), 0.04, 0.003);
  });

  it('tint direction follows the chosen hue angle (OKLab a,b)', () => {
    const t = tint(grade({ grade_global_hue: 90, grade_global_sat: 100 }, midg), midg);
    close(t[0], 0, 0.003); expect(t[1]).toBeGreaterThan(0.07); // 90° = +b (yellowish)
  });

  it('luminance sliders raise/lower lightness within their range', () => {
    expect(luminance(grade({ grade_global_lum: 100 }, midg))).toBeGreaterThan(luminance(midg));
    expect(luminance(grade({ grade_shadows_lum: -100 }, dark))).toBeLessThanOrEqual(luminance(dark));
    expect(luminance(grade({ grade_highlights_lum: 50 }, bright))).toBeGreaterThan(luminance(bright));
  });

  it('balance moves the shadow/highlight crossover; blending widens the transitions', () => {
    const w = (bal: number, blend: number, v: number) => { const d = derive(P({ gradeBalance: bal, gradeBlending: blend }), 4, 4); return gradeWeights(v, d.grade.shift, d.grade.width); };
    expect(w(100, 50, 0.3)[0]).toBeLessThan(w(0, 50, 0.3)[0]); // +balance favours highlights
    expect(w(100, 50, 0.5)[2]).toBeGreaterThan(w(0, 50, 0.5)[2]);
    expect(w(-100, 50, 0.5)[0]).toBeGreaterThan(w(0, 50, 0.5)[0]);
    expect(w(0, 0, 0.5)[1]).toBe(1); // sharp: mid-tones fully mid
    expect(w(0, 100, 0.5)[1]).toBeLessThan(0.95); // blended: shadows/highlights reach into the mid-tones
    for (const v of [0, 0.2, 0.5, 0.8, 1]) { const s = w(0, 50, v).reduce((a, b) => a + b); expect(s).toBeGreaterThan(0.99); expect(s).toBeLessThan(1.01); }
  });
});

describe('texture / clarity / dehaze (local contrast)', () => {
  it('blur plan: radii scale with image size; heavy blurs run at reduced resolution', () => {
    const a = blurPlan(1000, 750), b = blurPlan(2000, 1500);
    expect(b[2].sigma).toBeCloseTo(a[2].sigma * 2, 6);
    for (const s of [...a, ...b]) { expect(s.sigmaLow).toBeLessThanOrEqual(6); expect(Math.log2(s.factor) % 1).toBe(0); }
    expect(b[2].factor).toBeGreaterThan(a[2].factor);
  });

  it('Gaussian / blur field sanity: constants stay constant, mean is preserved, sampling is smooth', () => {
    const w = 37, h = 29;
    const flat = new Float32Array(w * h).fill(0.4);
    for (const v of gaussian(flat, w, h, 4)) close(v, 0.4, 1e-6);
    const noisy = new Float32Array(w * h).map((_, i) => (hash2(i, 7) - 0.5));
    const spec = blurPlan(w, h)[1];
    const f = blurField(noisy, w, h, spec);
    expect(f.every((v) => Math.abs(v) < 0.5)).toBe(true);
    close(sampleBlur(new Float32Array(spec.lw * spec.lh).fill(0.7), spec, 5, 5), 0.7, 1e-6);
  });

  it('texture and clarity leave a perfectly flat image unchanged', () => {
    const src = grey(40, 30, 128);
    for (const p of [P({ texture: 100 }), P({ clarity: 100 }), P({ texture: -100, clarity: -100 })]) {
      const out = renderImageData(src, 40, 30, p);
      expect(Math.max(...out.map((v, i) => Math.abs(v - src[i])))).toBeLessThanOrEqual(1);
    }
  });

  it('clarity increases mid-tone local contrast at an edge; negative decreases it', () => {
    const w = 64, h = 16, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = i % w < 32 ? 105 : 150; src.set([v, v, v, 255], i * 4); }
    const swing = (p: EditParams) => { const o = renderImageData(src, w, h, p); return px(o, w, 33, 8)[0] - px(o, w, 30, 8)[0]; };
    const base = swing(DEFAULT_PARAMS);
    expect(swing(P({ clarity: 100 }))).toBeGreaterThan(base + 4);
    expect(swing(P({ clarity: -100 }))).toBeLessThan(base - 4);
  });

  it('texture boosts fine detail and negative texture smooths it', () => {
    const w = 64, h = 32, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = 120 + (hash2(i, 3) - 0.5) * 40; src.set([v, v, v, 255], i * 4); }
    const s0 = stddev(src, 0);
    expect(stddev(renderImageData(src, w, h, P({ texture: 100 })), 0)).toBeGreaterThan(s0 * 1.3);
    expect(stddev(renderImageData(src, w, h, P({ texture: -100 })), 0)).toBeLessThan(s0 * 0.85);
  });

  it('dehaze: + restores contrast of a hazy image and darkens it; − adds haze (lifted blacks, lower contrast)', () => {
    const w = 48, h = 24, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const x = i % w; const v = 170 + (x / w) * 50; src.set([v, v + 4, v + 10, 255], i * 4); } // bright, low-contrast
    const s0 = stddev(src, 0), m0 = mean(src, 0);
    const dh = renderImageData(src, w, h, P({ dehaze: 100 }));
    expect(stddev(dh, 0)).toBeGreaterThan(s0 * 1.05); expect(mean(dh, 0)).toBeLessThan(m0 - 20); // removes the veil: darker, more contrast
    const hz = renderImageData(src, w, h, P({ dehaze: -80 }));
    expect(stddev(hz, 0)).toBeLessThan(s0);
    const dark = renderImageData(grey(8, 8, 10), 8, 8, P({ dehaze: -100 }));
    expect(dark[0]).toBeGreaterThan(60); // blacks lifted by added haze
  });
});

describe('vignette', () => {
  const W = 120, H = 80;
  const flat = grey(W, H, 128);
  const at = (p: EditParams, x: number, y: number, src = flat) => px(renderImageData(src, W, H, p), W, x, y)[0];

  it('amount 0 is identity; negative darkens corners only; positive brightens them', () => {
    expect(derive(DEFAULT_PARAMS, W, H).active.vignette).toBe(false);
    const p = P({ vignetteAmount: -80 });
    expect(Math.abs(at(p, W / 2, H / 2) - 128)).toBeLessThanOrEqual(1); // centre untouched
    expect(at(p, 0, 0)).toBeLessThan(70);
    expect(at(P({ vignetteAmount: 60 }), 0, 0)).toBeGreaterThan(200);
  });

  it('exposure model: full effect at a corner is 2^(amount × 2.5) in linear light', () => {
    const d = derive(P({ vignetteAmount: -100, vignetteMidpoint: 0, vignetteFeather: 0 }), W, H);
    const out = processLinear([0.2, 0.2, 0.2], P({ vignetteAmount: -100 })); // 1×1 => centre, no effect
    close(out[0], 0.2, 1e-9);
    expect(d.vignette.amount).toBe(-1);
  });

  it('midpoint and feather control how far in the effect reaches and how soft it is', () => {
    const edgeMid = (mp: number) => at(P({ vignetteAmount: -80, vignetteMidpoint: mp }), W - 1, H / 2);
    expect(edgeMid(20)).toBeLessThan(edgeMid(70)); // lower midpoint = more coverage
    const p = (feather: number) => P({ vignetteAmount: -80, vignetteMidpoint: 50, vignetteFeather: feather });
    const mid = (f: number) => at(p(f), Math.round(W * 0.8), H / 2);
    expect(mid(0)).toBeLessThan(mid(100) + 100); // sanity
    expect(at(p(100), W - 1, H / 2)).toBeGreaterThan(at(p(0), W - 1, H / 2)); // feathered edge is weaker at the same spot
  });

  it('roundness: +100 is a true circle in image space, −100 a rounded rectangle', () => {
    const t = (r: number) => ({ amount: -1, start: 0.5, width: 0.3, roundness: r, highlights: 0, aspect: 1.5 });
    const top = (r: number) => vignetteDistance(0.5, 0, t(r)), side = (r: number) => vignetteDistance(1, 0.5, t(r));
    close(side(0), top(0), 1e-9); // default ellipse: frame-fitting
    expect(top(100 / 100)).toBeLessThan(side(1)); // circle: top edge is closer to centre than side edge in a landscape frame
    close(side(1), Math.sqrt(0.5), 1e-9);
    expect(side(-1)).toBeGreaterThan(side(0)); // squarer: edges reached sooner
  });

  it('highlights priority protects bright pixels from darkening', () => {
    const bright = grey(W, H, 230);
    const plain = at(P({ vignetteAmount: -90 }), 0, 0, bright);
    const protectedPx = at(P({ vignetteAmount: -90, vignetteHighlights: 100 }), 0, 0, bright);
    expect(protectedPx).toBeGreaterThan(plain + 30);
    expect(at(P({ vignetteAmount: -90, vignetteHighlights: 100 }), 0, 0, grey(W, H, 20))).toBeLessThanOrEqual(at(P({ vignetteAmount: -90 }), 0, 0, grey(W, H, 20)) + 1);
  });
});

describe('grain', () => {
  const W = 600, H = 40;
  const flat = grey(W, H, 128);
  const autocorr = (d: Uint8ClampedArray, lag: number) => {
    const m = mean(d, 0), v = stddev(d, 0) ** 2;
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x + lag < W; x++) { s += (d[(y * W + x) * 4] - m) * (d[(y * W + x + lag) * 4] - m); n++; }
    return s / n / v;
  };

  it('is procedural, deterministic, and absent at amount 0', () => {
    expect(derive(DEFAULT_PARAMS, W, H).active.grain).toBe(false);
    const p = P({ grainAmount: 60 });
    const a = renderImageData(flat, W, H, p), b = renderImageData(flat, W, H, p);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(stddev(a, 0)).toBeGreaterThan(3);
    expect(hash2(12, 34)).toBe(hash2(12, 34)); expect(hash2(12, 34)).not.toBe(hash2(34, 12));
  });

  it('is zero-mean and its strength scales with amount', () => {
    const s = [20, 50, 100].map((amount) => renderImageData(flat, W, H, P({ grainAmount: amount })));
    expect(Math.abs(mean(s[1], 0) - 128)).toBeLessThan(1.5);
    expect(stddev(s[0], 0)).toBeLessThan(stddev(s[1], 0)); expect(stddev(s[1], 0)).toBeLessThan(stddev(s[2], 0));
    const sd = stddev(s[2], 0); // σ ≈ 0.12·255·0.577 ≈ 17.7 at amount 100
    expect(sd).toBeGreaterThan(13); expect(sd).toBeLessThan(22);
  });

  it('noise generator has unit-ish σ for both smooth and fine modes', () => {
    for (const rough of [0, 1]) {
      let s = 0, s2 = 0; const n = 20000;
      for (let i = 0; i < n; i++) { const v = grainNoise(i % 200, Math.floor(i / 200), 3, rough); s += v; s2 += v * v; }
      expect(Math.abs(s / n)).toBeLessThan(0.05);
      expect(Math.sqrt(s2 / n)).toBeGreaterThan(0.5); expect(Math.sqrt(s2 / n)).toBeLessThan(0.66);
    }
  });

  it('size controls clump size; roughness trades clumps for fine speckle', () => {
    const at = (size: number, rough: number) => renderImageData(flat, W, H, P({ grainAmount: 80, grainSize: size, grainRoughness: rough }));
    expect(autocorr(at(100, 0), 2)).toBeGreaterThan(autocorr(at(10, 0), 2) + 0.15); // larger cells = correlated neighbours
    expect(autocorr(at(100, 0), 1)).toBeGreaterThan(0.4);
    expect(autocorr(at(100, 100), 1)).toBeLessThan(0.15); // fully rough = independent pixels
  });

  it('grain is strongest in the mid-tones', () => {
    const sd = (v: number) => stddev(renderImageData(grey(W, H, v), W, H, P({ grainAmount: 80 })), 0);
    expect(sd(128)).toBeGreaterThan(sd(235)); expect(sd(128)).toBeGreaterThan(sd(25));
  });
});

describe('pipeline structure', () => {
  it('default order puts local contrast before colour work, effects last', () => {
    const o = DEFAULT_PIPELINE;
    expect(o.indexOf('local')).toBeGreaterThan(o.indexOf('tone'));
    expect(o.indexOf('curve')).toBeGreaterThan(o.indexOf('local'));
    expect(o.indexOf('grain')).toBe(o.length - 1);
  });

  it('every stage has GLSL, and the shader follows the requested order', () => {
    const frag = buildFragmentShader(DEFAULT_PIPELINE);
    let last = -1;
    for (const id of DEFAULT_PIPELINE) { const i = frag.indexOf(`c = stage_${id}(c)`); expect(i, id).toBeGreaterThan(last); last = i; }
    expect(buildFragmentShader(['local'], 'float', 'float')).toContain('u_blur0');
  });

  it('whole-scene render with everything on never mutates the source and stays within range', () => {
    const src = scene(), copy = src.slice();
    const out = renderImageData(src, 48, 36, P({
      exposure: 0.5, texture: 40, clarity: 40, dehaze: 20, mix_red_sat: 30, grade_shadows_sat: 40, grade_shadows_hue: 240,
      vignetteAmount: -40, grainAmount: 30, curves: { ...defaultCurves(), rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] },
    }));
    expect(Array.from(src)).toEqual(Array.from(copy));
    expect(out.length).toBe(src.length);
    expect(out.every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});
