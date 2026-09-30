// Renders a test image through the real WebGL2 shader (headless Chromium) and compares it
// to the CPU reference implementation. Fails if any channel differs by more than TOLERANCE.
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Use a system Chromium when present (CHROMIUM_PATH, or the pre-installed one in cloud sandboxes).
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const TOLERANCE = 2; // 8-bit levels (GPU float/pow precision + sRGB texture decode)
// helpers to build mask cases (plain JSON, resolved in the page)
let n = 0;
const C = (shape, op = 'add', invert = false) => ({ id: `c${n++}`, op, invert, shape });
const M = (components, adjust, extra = {}) => ({ id: `m${n++}`, name: 'Mask', enabled: true, invert: false, amount: 100, components, adjust, ...extra });
const STROKE = { radius: 0.09, feather: 0.6, flow: 0.8, density: 0.9, erase: false, points: [{ x: -0.3, y: -0.12, p: 1 }, { x: -0.1, y: 0.1, p: 1 }, { x: 0.15, y: 0.05, p: 1 }, { x: 0.3, y: -0.15, p: 1 }] };
const curveS = [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.84 }, { x: 1, y: 1 }];
const cases = [
  {},
  { exposure: 1 }, { exposure: -2 }, { exposure: 3.5 },
  { contrast: 60 }, { contrast: -70 },
  { highlights: -100 }, { shadows: 100 }, { whites: 70 }, { blacks: 100 }, { blacks: -100 },
  { temperature: 55 }, { temperature: -80, tint: 40 },
  { saturation: 60 }, { saturation: -100 }, { vibrance: 80 },
  // tone curve
  { curves: { rgb: curveS } },
  { curves: { r: [{ x: 0, y: 0.1 }, { x: 0.6, y: 0.8 }, { x: 1, y: 1 }], b: [{ x: 0.1, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.9 }] } },
  // colour mixer
  { mix_red_hue: 60, mix_red_sat: 50 }, { mix_blue_sat: -80, mix_blue_lum: 40 }, { mix_green_hue: -70, mix_yellow_lum: -50, mix_magenta_sat: 60, mix_orange_hue: 40 },
  // colour grading
  { grade_shadows_hue: 240, grade_shadows_sat: 60 }, { grade_highlights_hue: 50, grade_highlights_sat: 50, grade_highlights_lum: 30 },
  { grade_global_hue: 330, grade_global_sat: 30, grade_mid_hue: 120, grade_mid_sat: 40, gradeBalance: 40, gradeBlending: 80 },
  // presence (multi-pass)
  { texture: 70 }, { texture: -60 }, { clarity: 80 }, { clarity: -50 }, { dehaze: 60 }, { dehaze: -60 },
  { texture: 40, clarity: 40, dehaze: 30, exposure: 0.4, contrast: 20, saturation: 10 },
  // effects
  { vignetteAmount: -60 }, { vignetteAmount: 50, vignetteMidpoint: 30, vignetteFeather: 80 },
  { vignetteAmount: -80, vignetteRoundness: 100, vignetteHighlights: 60 }, { vignetteAmount: -70, vignetteRoundness: -100 },
  { grainAmount: 50 }, { grainAmount: 80, grainSize: 60, grainRoughness: 10 }, { grainAmount: 60, grainSize: 5, grainRoughness: 100 },
  // ---- Phase 3: geometry, crop, lens
  { crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.7 } },
  { orientation: 1 }, { orientation: 2, flipH: 1 }, { flipV: 1, orientation: 3 },
  { straighten: 4.5 }, { straighten: -12, geoScale: 130 },
  { geoVertical: 30 }, { geoHorizontal: -25 }, { geoVertical: -20, geoHorizontal: 15, geoRotate: 3 },
  { geoAspect: 40, geoScale: 120 }, { geoOffsetX: 12, geoOffsetY: -8, geoScale: 115 },
  { crop: { x: 0.1, y: 0.15, w: 0.5, h: 0.55 }, straighten: 6, geoVertical: 18, orientation: 1 },
  { lensDistortion: 60 }, { lensDistortion: -50 }, { lensVignetting: 70 }, { lensVignetting: -60 }, { lensCA: 80 },
  { lensProfile: 'example-wide' }, { lensProfile: 'example-tele', lensDistortion: 20, lensCA: -30 },
  { lensDistortion: 40, lensCA: 60, lensVignetting: 30, straighten: 3, crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } },
  // ---- Phase 4: masks (mask space: long edge = 1, so this 96x72 image spans x +-0.5, y +-0.375)
  { masks: [M([C({ type: 'linear', x1: 0, y1: -0.3, x2: 0, y2: 0.1, feather: 60 })], { exposure: -1.2 })] },
  { masks: [M([C({ type: 'linear', x1: -0.4, y1: -0.2, x2: 0.4, y2: 0.25, feather: 10 })], { exposure: 0.8, saturation: -40 })] },
  { masks: [M([C({ type: 'radial', cx: 0.05, cy: 0.05, rx: 0.3, ry: 0.18, rotation: 25, feather: 50 })], { exposure: 1, contrast: 30, temperature: 40 })] },
  { masks: [M([C({ type: 'radial', cx: 0, cy: 0, rx: 0.25, ry: 0.25, rotation: 0, feather: 30 }, 'add', true)], { exposure: -1, blacks: 30 })] },
  { masks: [M([C({ type: 'brush', strokes: [STROKE] })], { exposure: 1.2, tint: 30 })] },
  { masks: [M([C({ type: 'brush', strokes: [STROKE, { ...STROKE, erase: true, points: [{ x: -0.1, y: -0.05, p: 1 }, { x: 0.05, y: 0.05, p: 1 }], radius: 0.04 }] })], { highlights: -60, shadows: 50 })] },
  { masks: [M([C({ type: 'color', labFrom: [60, 180, 80], range: 35 })], { saturation: 60, exposure: 0.5 })] },
  { masks: [M([C({ type: 'luminance', min: 55, max: 100, smooth: 25 })], { exposure: -1, vibrance: 40 })] },
  { masks: [M([C({ type: 'luminance', min: 0, max: 30, smooth: 10 })], { shadows: 80, whites: -30 })] },
  { masks: [M([C({ type: 'linear', x1: 0, y1: -0.35, x2: 0, y2: 0.2, feather: 50 }), C({ type: 'radial', cx: 0, cy: -0.1, rx: 0.15, ry: 0.15, rotation: 0, feather: 40 }, 'subtract'), C({ type: 'luminance', min: 20, max: 100, smooth: 20 }, 'intersect')], { exposure: -0.8, temperature: -30 })] },
  { masks: [M([C({ type: 'linear', x1: 0, y1: -0.3, x2: 0, y2: 0.1, feather: 60 })], { exposure: -0.8 }, { invert: true, amount: 60 })] },
  { masks: [M([C({ type: 'radial', cx: -0.1, cy: 0, rx: 0.3, ry: 0.3, rotation: 0, feather: 60 })], { exposure: 0.7 }), M([C({ type: 'linear', x1: 0, y1: 0.3, x2: 0, y2: -0.1, feather: 50 })], { saturation: -60, contrast: 25 })] },
  // masked texture / clarity / dehaze (multi-pass + masks)
  { masks: [M([C({ type: 'radial', cx: -0.1, cy: 0, rx: 0.3, ry: 0.25, rotation: 0, feather: 50 })], { clarity: 80, texture: 60, dehaze: 40 })] },
  { clarity: 30, masks: [M([C({ type: 'linear', x1: 0, y1: -0.3, x2: 0, y2: 0.2, feather: 40 })], { dehaze: -50, exposure: 0.3 })] },
  // geometry + masks + everything
  { crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.8 }, straighten: 5, lensDistortion: 30, exposure: 0.3,
    masks: [M([C({ type: 'radial', cx: 0, cy: 0, rx: 0.3, ry: 0.2, rotation: 10, feather: 50 })], { exposure: 0.8, saturation: 30 })] },
  // everything at once
  {
    exposure: 0.5, contrast: 25, highlights: -30, shadows: 40, temperature: 12, vibrance: 20,
    curves: { rgb: curveS }, mix_blue_hue: -30, mix_red_sat: 20, grade_shadows_hue: 220, grade_shadows_sat: 30,
    texture: 30, clarity: 30, dehaze: 20, vignetteAmount: -30, grainAmount: 25,
  },
];

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('page error:', e.message); failed = true; });
  await page.goto('http://localhost:5199/parity.html');
  await page.waitForFunction(() => typeof window.runParity === 'function');
  const results = await page.evaluate((c) => window.runParity(c), cases);
  for (const r of results) {
    const noEffect = Object.keys(r.params).length > 0 && r.effect < 0.01; // an adjustment that changes nothing is a bug
    const bad = r.maxDiff > TOLERANCE || !r.localSupported || noEffect;
    if (bad) failed = true;
    console.log(`${bad ? 'FAIL' : 'ok  '} max=${r.maxDiff} mean=${r.meanDiff.toFixed(3)} effect=${r.effect.toFixed(2)} over2=${r.pixelsOver2}  ${JSON.stringify(r.params).slice(0, 100)}`);
  }

  // The half-size variant is only a sanity bound: this 96x72 test image is so small that the minimum blur radii (px floors) dominate
  // when halved; real photos (fw >= ~1000 px) are not affected. The exact variant above is the strict check.
  // ---- view windows (zoom/pan): the middle half drawn through a ViewWindow == the same pixels of the full render
  const exact = await page.evaluate((c) => window.runViewParity(c, 1), cases);
  const approx = await page.evaluate((c) => window.runViewParity(c, 0.5), cases);
  let vBad = 0, vMax = 0, aMax = 0, aMeanMax = 0;
  for (const r of exact) { vMax = Math.max(vMax, r.maxDiff); if (r.maxDiff > TOLERANCE) { vBad++; console.log(`FAIL view max=${r.maxDiff} ${JSON.stringify(r.params).slice(0, 100)}`); } }
  for (const r of approx) { aMax = Math.max(aMax, r.maxDiff); aMeanMax = Math.max(aMeanMax, r.meanDiff); if (r.meanDiff > 8) { vBad++; console.log(`FAIL view(approx blur) mean=${r.meanDiff.toFixed(2)} ${JSON.stringify(r.params).slice(0, 100)}`); } }
  console.log(`${vBad ? 'FAIL' : 'ok  '} view windows: ${exact.length} cases, exact-blur max diff ${vMax}; half-size blur source: max ${aMax}, worst mean ${aMeanMax.toFixed(2)}`);
  if (vBad || exact.length < 40) failed = true;
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? '\nGPU parity: FAILED' : `\nGPU parity: OK (all ${cases.length} cases within ±${TOLERANCE} levels)`);
process.exit(failed ? 1 : 0);
