// Renders a test image through the real WebGL2 shader (headless Chromium) and compares it
// to the CPU reference implementation. Fails if any channel differs by more than TOLERANCE.
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Use a system Chromium when present (CHROMIUM_PATH, or the pre-installed one in cloud sandboxes).
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const TOLERANCE = 2; // 8-bit levels (GPU float/pow precision + sRGB texture decode)
const cases = [
  {},
  { exposure: 1 }, { exposure: -2 }, { exposure: 3.5 },
  { contrast: 60 }, { contrast: -70 },
  { highlights: -100 }, { highlights: 80 }, { shadows: 100 }, { shadows: -60 },
  { whites: 70 }, { whites: -90 }, { blacks: 100 }, { blacks: -100 },
  { temperature: 55 }, { temperature: -80, tint: 40 }, { tint: -60 },
  { saturation: 60 }, { saturation: -100 }, { vibrance: 80 }, { vibrance: -50 },
  { exposure: 0.7, contrast: 35, highlights: -40, shadows: 55, whites: 20, blacks: -15, temperature: 18, tint: -9, vibrance: 30, saturation: -12 },
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
    const bad = r.maxDiff > TOLERANCE;
    if (bad) failed = true;
    console.log(`${bad ? 'FAIL' : 'ok  '} max=${r.maxDiff} mean=${r.meanDiff.toFixed(3)}  ${JSON.stringify(r.params)}`);
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
