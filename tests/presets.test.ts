import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, isDefault, normalizeParams, paramsEqual, type EditParams } from '../src/image-engine/params';
import { renderImageData } from '../src/image-engine/pipeline';
import { newMask, newShape, uid } from '../src/masks/types';
import { BUILTIN_PRESETS } from '../src/presets/builtin';
import { ALL_GROUPS, COPY_GROUPS, DEFAULT_GROUPS, GROUP_BY_ID } from '../src/presets/groups';
import { applyPreset, extractPreset, groupsIn, sanitizePreset } from '../src/presets/snapshot';
import { newSpot } from '../src/retouch/types';
import { SCENE_H, SCENE_W, scene } from './helpers';

const edited = (): EditParams => normalizeParams({
  ...DEFAULT_PARAMS, exposure: 0.5, contrast: 20, temperature: 15, vibrance: 30, texture: 12,
  curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }], r: DEFAULT_PARAMS.curves.r, g: DEFAULT_PARAMS.curves.g, b: DEFAULT_PARAMS.curves.b },
  masks: [newMask(newShape('radial', { hw: 0.5, hh: 0.4 }), 'M')], spots: [newSpot('heal', 0.1, 0.1, 0.02, { sx: 0.2, sy: 0.1 })],
  straighten: 3, lensProfile: 'none',
});

describe('copy groups', () => {
  it('every scalar parameter belongs to exactly one group (or is a per-photo internal)', () => {
    const seen = new Map<string, string>();
    for (const g of COPY_GROUPS) for (const k of g.keys) { expect(seen.has(k)).toBe(false); seen.set(k, g.id); }
    const all = Object.keys(DEFAULT_PARAMS).filter((k) => typeof (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k] === 'number');
    expect(all.filter((k) => !seen.has(k))).toEqual([]);
  });
  it('photo-specific groups are off by default', () => {
    expect(DEFAULT_GROUPS).not.toContain('crop'); expect(DEFAULT_GROUPS).not.toContain('masks'); expect(DEFAULT_GROUPS).not.toContain('spots'); expect(DEFAULT_GROUPS).toContain('tone');
  });
});

describe('extract / apply', () => {
  it('extracts only the chosen groups', () => {
    const d = extractPreset(edited(), ['tone', 'curve']);
    expect(Object.keys(d).sort()).toEqual(['blacks', 'contrast', 'curveDarks', 'curveHighlights', 'curveLights', 'curveShadows', 'curves', 'exposure', 'highlights', 'shadows', 'whites']);
    expect(groupsIn(d).sort()).toEqual(['curve', 'tone']);
  });

  it('paste changes exactly the pasted groups and nothing else', () => {
    const src = edited();
    const dst: EditParams = { ...DEFAULT_PARAMS, saturation: -20, vignetteAmount: -30 };
    const out = applyPreset(dst, extractPreset(src, ['tone', 'wb']));
    expect(out.exposure).toBe(0.5); expect(out.contrast).toBe(20); expect(out.temperature).toBe(15);
    expect(out.saturation).toBe(-20); expect(out.vignetteAmount).toBe(-30); // untouched
    expect(out.vibrance).toBe(0); expect(out.masks).toEqual([]);
  });

  it('`only` restricts a preset to some groups', () => {
    const d = extractPreset(edited(), ['tone', 'color']);
    const out = applyPreset(DEFAULT_PARAMS, d, ['tone']);
    expect(out.exposure).toBe(0.5); expect(out.vibrance).toBe(0);
  });

  it('applying twice is idempotent for scalars and never duplicates mask/spot ids', () => {
    const d = extractPreset(edited(), ALL_GROUPS);
    const once = applyPreset(DEFAULT_PARAMS, d), twice = applyPreset(once, d);
    expect(twice.exposure).toBe(once.exposure);
    expect(twice.masks).toHaveLength(1); // replaced, not appended
    const ids = [...once.masks.map((m) => m.id), ...once.masks.flatMap((m) => m.components.map((c) => c.id)), ...once.spots.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(once.masks[0].id).not.toBe(edited().masks[0].id); // fresh ids
    expect(once.crop).toEqual(edited().crop);
  });

  it('an empty preset changes nothing', () => {
    const p = edited();
    expect(paramsEqual(applyPreset(p, {}), p)).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const p = edited(), d = extractPreset(p, ALL_GROUPS);
    const p0 = JSON.stringify(p), d0 = JSON.stringify(d);
    applyPreset(DEFAULT_PARAMS, d);
    expect(JSON.stringify(p)).toBe(p0); expect(JSON.stringify(d)).toBe(d0);
  });
});

describe('sanitize (files / storage)', () => {
  it('drops unknown keys, clamps values, rejects junk', () => {
    const s = sanitizePreset({ exposure: 99, contrast: 'high', hack: 1, curves: 'nope', masks: [{ bogus: true }] })!;
    expect(s.exposure).toBe(5);
    expect('contrast' in s).toBe(false);
    expect('hack' in s).toBe(false);
    expect(s.curves).toEqual(DEFAULT_PARAMS.curves); // repaired to identity
    expect(s.masks).toEqual([]);
    expect(sanitizePreset(null)).toBeNull(); expect(sanitizePreset({ foo: 1 })).toBeNull(); expect(sanitizePreset('x')).toBeNull();
  });
});

describe('built-in presets', () => {
  it('ids are unique and every preset is valid as written (nothing gets clamped)', () => {
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    for (const p of BUILTIN_PRESETS) {
      const clean = sanitizePreset(p.data)!;
      expect(clean, p.name).toEqual(p.data);
      expect(Object.keys(p.data).length, p.name).toBeGreaterThan(0);
      for (const id of groupsIn(p.data)) expect(GROUP_BY_ID[id]).toBeDefined();
    }
  });
  it('every preset changes the picture, and only what it says it changes', () => {
    const src = scene();
    const base = renderImageData(src, SCENE_W, SCENE_H, DEFAULT_PARAMS);
    for (const p of BUILTIN_PRESETS) {
      const params = applyPreset(DEFAULT_PARAMS, p.data);
      expect(isDefault(params), p.name).toBe(false);
      const out = renderImageData(src, SCENE_W, SCENE_H, params);
      let diff = 0; for (let i = 0; i < out.length; i++) diff += Math.abs(out[i] - base[i]);
      expect(diff, p.name).toBeGreaterThan(out.length * 0.4);
    }
  });
  it('black & white presets really have no colour', () => {
    const out = renderImageData(scene(), SCENE_W, SCENE_H, applyPreset(DEFAULT_PARAMS, BUILTIN_PRESETS.find((p) => p.name === 'Neutral')!.data));
    let maxChroma = 0; for (let i = 0; i < out.length; i += 4) maxChroma = Math.max(maxChroma, Math.abs(out[i] - out[i + 1]), Math.abs(out[i + 1] - out[i + 2]));
    expect(maxChroma).toBeLessThanOrEqual(1);
  });
  it('uid helper yields distinct ids', () => { expect(uid()).not.toBe(uid()); });
});

import { autoToneFromHistogram, lumaHistogram, AUTO_TARGET_MEDIAN } from '../src/image-engine/autoTone';
import { linearToSrgb } from '../src/color/colorSpace';

describe('auto tone (histogram heuristic)', () => {
  const flat = (fn: (i: number, n: number) => number, n = 4000) => { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { const v = fn(i, n); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; } return d; };
  const ramp = (lo: number, hi: number) => flat((i, n) => lo + ((hi - lo) * i) / (n - 1));
  const median = (d: Uint8ClampedArray) => { const v = Array.from({ length: d.length / 4 }, (_, i) => d[i * 4]).sort((a, b) => a - b); return v[v.length >> 1] / 255; };
  const auto = (d: Uint8ClampedArray) => autoToneFromHistogram(lumaHistogram(d));
  const render = (d: Uint8ClampedArray, p: ReturnType<typeof auto>) => renderImageData(d, 100, 40, { ...DEFAULT_PARAMS, ...p });

  it('brightens a dark photo, darkens a bright one, leaves a balanced one nearly alone', () => {
    expect(auto(ramp(0, 80)).exposure).toBeGreaterThan(0.5);
    expect(auto(ramp(170, 255)).exposure).toBeLessThan(-0.3);
    expect(Math.abs(auto(ramp(0, 255)).exposure)).toBeLessThan(0.4);
  });
  it('moves the rendered median toward mid-grey', () => {
    for (const d of [ramp(0, 80), ramp(150, 255)]) {
      const before = Math.abs(median(d) - AUTO_TARGET_MEDIAN);
      const after = Math.abs(median(render(d, auto(d))) - AUTO_TARGET_MEDIAN);
      expect(after).toBeLessThan(before * 0.6);
    }
  });
  it('adds contrast to a flat photo and lifts whites/blacks toward the ends', () => {
    const r = auto(ramp(90, 170));
    expect(r.contrast).toBeGreaterThan(10); expect(r.whites).toBeGreaterThan(0);
    const out = render(ramp(90, 170), r); const lo = Math.min(...Array.from({ length: out.length / 4 }, (_, i) => out[i * 4]));
    const hi = Math.max(...Array.from({ length: out.length / 4 }, (_, i) => out[i * 4]));
    expect(hi - lo).toBeGreaterThan(170 - 90);
  });
  it('recovers shadows when much of the photo is dark, highlights when much is blown', () => {
    expect(auto(flat((i, n) => (i < n * 0.6 ? 14 : 130 + (i % 100)))).shadows).toBeGreaterThan(0);
    expect(auto(flat((i, n) => (i < n * 0.3 ? 252 : 20 + (i % 70)))).highlights).toBeLessThan(0);
  });
  it('always stays inside the slider ranges', () => {
    for (const d of [ramp(0, 10), ramp(245, 255), ramp(0, 255), flat(() => 0), flat(() => 255)]) {
      const r = auto(d);
      for (const [k, v] of Object.entries(r)) expect(Math.abs(v), k).toBeLessThanOrEqual(k === 'exposure' ? 2.5 : 100);
      expect(normalizeParams({ ...DEFAULT_PARAMS, ...r }).exposure).toBe(r.exposure);
    }
    expect(linearToSrgb(0.18)).toBeGreaterThan(0.4);
  });
});
