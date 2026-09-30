// Renders a test image through the real WebGL2 shader (headless Chromium) and compares it
// to the CPU reference implementation. Fails if any channel differs by more than TOLERANCE.
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Use a system Chromium when present (CHROMIUM_PATH, or the pre-installed one in cloud sandboxes).
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const TOLERANCE = 2; // 8-bit levels (GPU float/pow precision + sRGB texture decode)
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
    console.log(`${bad ? 'FAIL' : 'ok  '} max=${r.maxDiff} mean=${r.meanDiff.toFixed(3)} effect=${r.effect.toFixed(2)} over2=${r.pixelsOver2}  ${JSON.stringify(r.params).slice(0, 110)}`);
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? '\nGPU parity: FAILED' : `\nGPU parity: OK (all ${cases.length} cases within ±${TOLERANCE} levels)`);
process.exit(failed ? 1 : 0);
