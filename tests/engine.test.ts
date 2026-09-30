import { describe, expect, it } from 'vitest';
import { linearToSrgb, luminance, srgbToLinear, type Vec3 } from '../src/color/colorSpace';
import { applyColor, contrastCurve, contrastShape, solveWhiteBalance, toneCurve, toneWeight, wbMultipliers } from '../src/image-engine/model';
import { DEFAULT_PARAMS, SLIDERS, normalizeParams, type EditParams } from '../src/image-engine/params';
import { DEFAULT_PIPELINE, processLinear, renderImageData as renderRaw, renderPixel8 } from '../src/image-engine/pipeline';
import { scene, SCENE_H, SCENE_W } from './helpers';
import { computeHistogram } from '../src/image-engine/histogram';
import { buildFragmentShader, derivedToUniforms } from '../src/image-engine/glsl';
import { derive } from '../src/image-engine/derive';

const P = (over: Partial<EditParams>): EditParams => ({ ...DEFAULT_PARAMS, ...over });
/** Render a 1-row strip (width = pixel count). */
const renderImageData = (src: Uint8ClampedArray | Uint8Array, p: EditParams) => renderRaw(src, src.length / 4, 1, p);
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

/** 256 x 1 ramp per channel plus colourful patches, as RGBA8. */
function testImage(): Uint8ClampedArray {
  const px: number[] = [];
  for (let i = 0; i < 256; i++) px.push(i, i, i, 255);
  for (let i = 0; i < 256; i++) px.push(i, 255 - i, (i * 7) % 256, 255);
  for (const c of [[200, 120, 80], [40, 90, 200], [10, 10, 10], [250, 250, 245], [128, 128, 128]]) px.push(...c, 255);
  return new Uint8ClampedArray(px);
}

describe('colour space', () => {
  it('sRGB encode/decode round-trips', () => {
    for (let i = 0; i <= 255; i++) close(linearToSrgb(srgbToLinear(i / 255)) * 255, i, 1e-9 * 255 + 1e-6);
  });
});

import { applyAllDetail, detailParamsOf } from '../src/image-engine/detail';
const renderRawBase = (...a: Parameters<typeof renderRaw>) => renderRaw(...a);

describe('identity and non-destruction', () => {
  it('default parameters reproduce the original exactly (all 8-bit values)', () => {
    const src = testImage();
    const out = renderImageData(src, DEFAULT_PARAMS);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it('rendering never mutates the source pixels', () => {
    const src = testImage();
    const copy = src.slice();
    renderImageData(src, P({ exposure: 2, contrast: 50, saturation: -40, temperature: 30 }));
    expect(Array.from(src)).toEqual(Array.from(copy));
  });

  it('every slider is a real parameter that changes the rendered output', () => {
    const src = scene();
    const base = renderRaw(src, SCENE_W, SCENE_H, DEFAULT_PARAMS);
    for (const s of SLIDERS) {
      if (s.key === 'grainSize') continue; // grain cells scale with image size; covered on a wide strip in phase2.test.ts
      // Hue controls only act when their saturation is non-zero.
      const tinted = { grade_shadows_sat: 60, grade_shadows_hue: 240, grade_mid_sat: 40, grade_mid_hue: 100, grade_highlights_sat: 60, grade_highlights_hue: 40 };
      const prep: Partial<EditParams> =
        s.key.startsWith('grade_') && s.key.endsWith('_hue') ? { [s.key.replace('_hue', '_sat')]: 60 }
        : s.key === 'gradeBlending' || s.key === 'gradeBalance' ? tinted // only matter once something is tinted
        : s.section === 'vignette' && s.key !== 'vignetteAmount' ? { vignetteAmount: -60 } // modifiers need an active vignette
        : s.section === 'grain' && s.key !== 'grainAmount' ? { grainAmount: 50 }
        : s.key.startsWith('sharp') && s.key !== 'sharpAmount' ? { sharpAmount: 80 } // modifiers need sharpening on
        : (s.key === 'nrLumaDetail' || s.key === 'nrLumaContrast') ? { nrLuma: 50 }
        : (s.key === 'nrColorDetail' || s.key === 'nrColorSmooth') ? { nrColor: 60 }
        : {};
      // Detail (sharpening / noise reduction) is a pre-pass over the source pixels, so include it in the render
      const renderRaw = (px: Uint8ClampedArray, w: number, h: number, p: EditParams) => renderRawBase(applyAllDetail(px, w, h, detailParamsOf(p as unknown as Record<string, unknown>), p.masks), w, h, p);
      const ref = renderRaw(src, SCENE_W, SCENE_H, P(prep));
      const isHue = s.key.startsWith('grade_') && s.key.endsWith('_hue'); // 360° wraps to 0°, so test interior angles
      for (const v of isHue ? [90, 200] : [s.min, s.max]) {
        if (v === s.default) continue;
        const out = renderRaw(src, SCENE_W, SCENE_H, P({ ...prep, [s.key]: v }));
        const changed = out.some((x, i) => x !== ref[i]);
        expect(changed, `${s.key}=${v} should change the image`).toBe(true);
      }
    }
    expect(base.length).toBe(src.length);
  });

  it('every slider reaches the shader as a uniform and declares a sane range/default', () => {
    const u = derivedToUniforms(derive(DEFAULT_PARAMS, 10, 10));
    const frag = buildFragmentShader(DEFAULT_PIPELINE);
    for (const name of Object.keys(u)) expect(frag, name).toContain(name);
    for (const s of SLIDERS) {
      expect(s.min).toBeLessThan(s.max);
      expect(s.default).toBeGreaterThanOrEqual(s.min);
      expect(s.default).toBeLessThanOrEqual(s.max);
    }
  });

  it('normalizeParams clamps, drops unknown keys and fills defaults', () => {
    const p = normalizeParams({ exposure: 99, contrast: 'x', bogus: 1, tint: -500 });
    expect(p.exposure).toBe(5);
    expect(p.contrast).toBe(0);
    expect(p.curves.rgb).toHaveLength(2);
    expect(p.tint).toBe(-100);
    expect('bogus' in p).toBe(false);
  });
});

describe('exposure', () => {
  const c: Vec3 = [0.05, 0.1, 0.02];
  it('+1 stop doubles linear light, −1 halves it', () => {
    // Isolate exposure from the tone stage, which is identity at defaults but rounds-trips via sRGB.
    const up = processLinear(c, P({ exposure: 1 }), ['exposure']);
    const dn = processLinear(c, P({ exposure: -1 }), ['exposure']);
    for (let i = 0; i < 3; i++) { close(up[i], c[i] * 2); close(dn[i], c[i] / 2); }
  });
  it('the full pipeline also doubles linear light at exposure +1 with all else neutral', () => {
    const up = processLinear(c, P({ exposure: 1 }));
    for (let i = 0; i < 3; i++) close(up[i] / (c[i] * 2), 1, 1e-6);
  });
  it('is not a simple add on encoded values', () => {
    const dark = renderPixel8([20, 20, 20], P({ exposure: 1 }));
    const mid = renderPixel8([128, 128, 128], P({ exposure: 1 }));
    expect(dark[0] - 20).toBeLessThan(mid[0] - 128 + 40); // sanity
    close(srgbToLinear(mid[0] / 255) / srgbToLinear(128 / 255), 2, 0.05);
  });
});

describe('contrast', () => {
  it('is identity at 0, fixes black/mid/white, and is monotonic', () => {
    for (const c of [-100, -40, 0, 40, 100]) {
      const m = contrastShape(c);
      close(contrastCurve(0, m), 0); close(contrastCurve(0.5, m), 0.5); close(contrastCurve(1, m), 1);
      let prev = -1;
      for (let i = 0; i <= 1000; i++) { const y = contrastCurve(i / 1000, m); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
    }
    for (let i = 0; i <= 10; i++) close(contrastCurve(i / 10, 0), i / 10);
  });
  it('positive separates tones, negative compresses them', () => {
    expect(contrastCurve(0.25, contrastShape(60))).toBeLessThan(0.25);
    expect(contrastCurve(0.75, contrastShape(60))).toBeGreaterThan(0.75);
    expect(contrastCurve(0.25, contrastShape(-60))).toBeGreaterThan(0.25);
    expect(contrastCurve(0.75, contrastShape(-60))).toBeLessThan(0.75);
  });
});

describe('highlights / shadows / whites / blacks', () => {
  const delta = (over: Partial<EditParams>, v: number) => toneCurve(v, P(over)) - v;
  it('weights are smooth, in [0,1] and peak in the right region', () => {
    for (const r of ['shadows', 'highlights', 'whites', 'blacks'] as const)
      for (let i = 0; i <= 100; i++) { const w = toneWeight(i / 100, r); expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(1); }
    expect(toneWeight(0.05, 'shadows')).toBeGreaterThan(toneWeight(0.5, 'shadows'));
    expect(toneWeight(0.95, 'highlights')).toBeGreaterThan(toneWeight(0.5, 'highlights'));
    expect(toneWeight(0.95, 'whites')).toBeGreaterThan(toneWeight(0.6, 'whites'));
    expect(toneWeight(0.0, 'blacks')).toBe(1);
    expect(toneWeight(0.5, 'blacks')).toBe(0);
  });
  it('each slider acts mainly on its own region', () => {
    expect(delta({ highlights: -100 }, 0.9)).toBeLessThan(-0.05);
    expect(Math.abs(delta({ highlights: -100 }, 0.15))).toBeLessThan(1e-9);
    expect(delta({ shadows: 100 }, 0.15)).toBeGreaterThan(0.05);
    expect(Math.abs(delta({ shadows: 100 }, 0.85))).toBeLessThan(1e-9);
    expect(delta({ whites: 100 }, 0.98)).toBeGreaterThan(0.05);
    expect(Math.abs(delta({ whites: 100 }, 0.4))).toBeLessThan(1e-9);
    expect(delta({ blacks: 100 }, 0.02)).toBeGreaterThan(0.05);
    expect(Math.abs(delta({ blacks: 100 }, 0.6))).toBeLessThan(1e-9);
  });
  it('tone mapping stays monotonic for every combination of extreme settings', () => {
    const vals = [-100, 0, 100];
    for (const contrast of vals) for (const highlights of vals) for (const shadows of vals) for (const whites of vals) for (const blacks of vals) {
      const p = { contrast, highlights, shadows, whites, blacks };
      let prev = -Infinity;
      for (let i = 0; i <= 500; i++) { const y = toneCurve(i / 500, p); expect(y, JSON.stringify(p) + ' @' + i / 500).toBeGreaterThanOrEqual(prev - 1e-12); prev = y; }
    }
  });
  it('Blacks can lift pure black; other pixels keep their hue under tone changes', () => {
    const lifted = processLinear([0, 0, 0], P({ blacks: 100 }));
    expect(lifted[0]).toBeGreaterThan(0);
    close(lifted[0], lifted[2], 1e-9);
    const c: Vec3 = [0.4, 0.2, 0.1];
    const o = processLinear(c, P({ shadows: 60, contrast: 30 }), ['tone']);
    close(o[0] / o[1], c[0] / c[1], 1e-6);
    close(o[1] / o[2], c[1] / c[2], 1e-6);
  });
});

describe('white balance', () => {
  it('multipliers preserve luminance of white and warm = more red/less blue', () => {
    for (const [t, s] of [[0, 0], [60, 0], [-60, 30], [20, -80]]) close(luminance(wbMultipliers(t, s)), 1, 1e-9);
    const w = wbMultipliers(50, 0);
    expect(w[0]).toBeGreaterThan(1); expect(w[2]).toBeLessThan(1);
    expect(wbMultipliers(0, 50)[1]).toBeLessThan(1);
  });
  it('solveWhiteBalance neutralises a tinted grey (round-trip)', () => {
    for (const [t, s] of [[35, -20], [-50, 40], [0, 0], [80, 10]]) {
      const m = wbMultipliers(t, s);
      const tinted: Vec3 = [0.3 / m[0], 0.3 / m[1], 0.3 / m[2]]; // a grey that was shifted by the inverse
      const r = solveWhiteBalance(tinted);
      close(r.temperature, t, 1e-6); close(r.tint, s, 1e-6);
      const corrected = processLinear(tinted, P({ temperature: r.temperature, tint: r.tint }), ['whiteBalance']);
      close(corrected[0], corrected[1], 1e-9); close(corrected[1], corrected[2], 1e-9);
    }
  });
});

describe('colour', () => {
  const c: Vec3 = [0.5, 0.3, 0.1];
  it('saturation −100 is greyscale at the same luminance; 0 is identity', () => {
    const g = applyColor(c, P({ saturation: -100 }));
    close(g[0], g[1]); close(g[1], g[2]); close(g[0], luminance(c), 1e-9);
    expect(applyColor(c, DEFAULT_PARAMS)).toEqual(c);
  });
  it('saturation +50 increases chroma while keeping luminance', () => {
    const o = applyColor(c, P({ saturation: 50 }));
    expect(o[0] - o[2]).toBeGreaterThan(c[0] - c[2]);
    close(luminance(o), luminance(c), 1e-9);
  });
  it('vibrance boosts muted colours more than saturated ones', () => {
    const muted: Vec3 = [0.4, 0.36, 0.33], vivid: Vec3 = [0.8, 0.1, 0.05];
    const gain = (x: Vec3) => { const o = applyColor(x, P({ vibrance: 80 })); return (Math.max(...o) - Math.min(...o)) / (Math.max(...x) - Math.min(...x)); };
    expect(gain(muted)).toBeGreaterThan(gain(vivid));
  });
});

describe('pipeline order is data', () => {
  it('order can change and the shader follows it', () => {
    const a = buildFragmentShader(['exposure', 'tone']);
    expect(a.indexOf('stage_exposure(c)')).toBeLessThan(a.indexOf('stage_tone(c)'));
    const b = buildFragmentShader(['tone', 'exposure']);
    expect(b.indexOf('c = stage_tone(c)')).toBeLessThan(b.indexOf('c = stage_exposure(c)'));
    const p = P({ exposure: 1.5, contrast: 40 });
    const x = processLinear([0.2, 0.3, 0.1], p, ['exposure', 'tone']);
    const y = processLinear([0.2, 0.3, 0.1], p, ['tone', 'exposure']);
    expect(x).not.toEqual(y);
  });
});

describe('histogram', () => {
  it('counts rendered pixels per channel and clipping', () => {
    const rgba = new Uint8Array([0, 10, 255, 255, 255, 255, 255, 255, 5, 5, 5, 255, 5, 5, 5, 255]);
    const h = computeHistogram(rgba);
    expect(h.pixels).toBe(4);
    expect(h.r[5]).toBe(2); expect(h.r[255]).toBe(1); expect(h.r[0]).toBe(1);
    expect(h.b[255]).toBe(2);
    expect(h.clipHigh).toBe(0.5); expect(h.clipLow).toBe(0.25);
    expect(h.luma.reduce((a, b) => a + b, 0)).toBe(4);
  });
  it('reflects edits: exposure shifts the histogram mean up', () => {
    const src = testImage();
    const mean = (d: Uint8ClampedArray) => { const h = computeHistogram(d); let s = 0; h.luma.forEach((n, i) => (s += n * i)); return s / h.pixels; };
    expect(mean(renderImageData(src, P({ exposure: 1 })))).toBeGreaterThan(mean(src));
    expect(mean(renderImageData(src, P({ exposure: -1 })))).toBeLessThan(mean(src));
  });
});
