// End-to-end checks for Phases 5-7 (retouch, library, presets, export, zoom) in headless Chromium.
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
mkdirSync('scripts/.out', { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5199/');

  /** A smooth photo with one dark blemish at (DOT_X, DOT_Y) (fractions of the frame) and a coloured block. */
  const makePhoto = (seed) => page.evaluate(async (seed) => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1200, 800);
    grad.addColorStop(0, `hsl(${200 + seed * 40}, 45%, 62%)`); grad.addColorStop(1, `hsl(${30 + seed * 40}, 50%, 55%)`);
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = '#101010'; g.beginPath(); g.arc(600, 400, 16, 0, Math.PI * 2); g.fill(); // the blemish
    g.fillStyle = `hsl(${seed * 70}, 70%, 40%)`; g.fillRect(120, 560, 160, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; buf.forEach((v) => (s += String.fromCharCode(v)));
    return btoa(s);
  }, seed);
  const importPhoto = async (name, seed) => {
    const jpg = Buffer.from(await makePhoto(seed), 'base64');
    await page.setInputFiles('input[type=file]', { name, mimeType: 'image/jpeg', buffer: jpg });
    await page.waitForFunction((n) => document.querySelector('.file-name')?.textContent?.startsWith(n), name);
    await page.waitForTimeout(500);
  };
  /** RGB of the on-screen canvas at fractional position (fx, fy), from a real element screenshot. */
  const pixelAt = async (fx, fy, sel = '[data-testid=viewer-canvas]') => {
    const png = await page.locator(sel).screenshot();
    return page.evaluate(async ([b64, fx, fy]) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const t = document.createElement('canvas'); t.width = bmp.width; t.height = bmp.height; const x = t.getContext('2d'); x.drawImage(bmp, 0, 0);
      return Array.from(x.getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * fy), 1, 1).data).slice(0, 3);
    }, [png.toString('base64'), fx, fy]);
  };
  const dark = (p) => p[0] + p[1] + p[2] < 150;
  const canvasBox = () => page.locator('[data-testid=viewer-canvas]').boundingBox();
  const clickAt = async (fx, fy) => { const b = await canvasBox(); await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy); await page.waitForTimeout(250); };
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const historyCount = () => page.locator('.history-list li').count();

  // ====================================================================== PHASE 5: retouch
  await importPhoto('blemish.jpg', 0);
  check('blemish is visible in the untouched photo', dark(await pixelAt(0.5, 0.5)), JSON.stringify(await pixelAt(0.5, 0.5)));

  await page.keyboard.press('q');
  check('Q opens the Retouch tool', (await page.locator('[data-tool=retouch].on').count()) === 1);
  await page.locator('[data-spot-kind=remove]').click();
  await page.locator('[data-retouch=size] .slider-number').fill('40'); await page.locator('[data-retouch=size] .slider-number').press('Enter');
  await page.evaluate(() => document.activeElement?.blur());
  const h0 = await historyCount();
  await clickAt(0.5, 0.5);
  check('clicking adds exactly one spot', (await page.locator('[data-spot-row]').count()) === 1 && (await historyCount()) === h0 + 1);
  await page.locator('label.chk:has-text("Show spots") input').uncheck(); await blur();
  await page.waitForTimeout(300);
  const healed = await pixelAt(0.5, 0.5);
  check('Remove takes the blemish out', !dark(healed), JSON.stringify(healed));
  const around = await pixelAt(0.56, 0.5);
  check('the filled area blends with its surroundings', Math.hypot(healed[0] - around[0], healed[1] - around[1], healed[2] - around[2]) < 40, `${healed} vs ${around}`);

  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  check('Undo brings the blemish back', dark(await pixelAt(0.5, 0.5)));
  await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(300);
  check('Redo removes it again', !dark(await pixelAt(0.5, 0.5)));

  await page.keyboard.press('\\'); await page.waitForTimeout(300);
  check('Before/After shows the genuine original (blemish present)', dark(await pixelAt(0.5, 0.5)));
  await page.keyboard.press('\\'); await page.waitForTimeout(300);

  await page.waitForTimeout(700); // let the debounced save run
  await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(900);
  check('spot is restored after reload', !dark(await pixelAt(0.5, 0.5)));

  // Clone: a hand-placed source
  await page.keyboard.press('q');
  await page.locator('[data-spot-kind=clone]').click();
  await page.locator('label.chk:has-text("Show spots") input').check();
  check('spot list shows the Remove spot', (await page.locator('[data-spot-row]').count()) === 1);
  await page.locator('[data-spot-row] button[aria-label="Delete spot"]').click(); await page.waitForTimeout(300);
  check('deleting the spot brings the blemish back', dark(await pixelAt(0.5, 0.5)));
  await page.screenshot({ path: 'scripts/.out/retouch.png' });

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error(e);
  results.push(false);
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
