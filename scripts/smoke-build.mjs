// Smoke test of the BUILT single-file page (dist-single/roomlight.html): import, edit, export through the inlined worker.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const html = readFileSync('dist-single/roomlight.html', 'utf8');
const page_ = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>${html}</body></html>`;
const srv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(page_); }).listen(5196);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let ok = true;
const check = (name, pass, d = '') => { if (!pass) ok = false; console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('http://localhost:5196/');
  const b64 = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#3a7bd5'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#e8a33d'; g.fillRect(300, 200, 300, 200); const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; u.forEach((v) => (s += String.fromCharCode(v))); return btoa(s); });
  await page.setInputFiles('input[type=file]', { name: 'smoke.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await page.waitForSelector('.thumb.current'); await page.waitForTimeout(700);
  check('built page imports and renders a photo', (await page.locator('[data-testid=viewer-canvas]').count()) === 1);
  await page.keyboard.press('Control+Shift+E'); await page.locator('[role=dialog]').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=export-go]').click()]);
  await page.locator('[data-testid=export-done]').waitFor();
  const path = 'scripts/.out/smoke.jpg'; await dl.saveAs(path);
  const bytes = readFileSync(path);
  check('built page exports a real JPEG', bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length > 2000, `${bytes.length} bytes`);
  const where = await page.locator('[data-testid=export-where]').innerText();
  check('the inlined export worker runs in the built page', /background worker/.test(where), where);
  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { console.error(e); ok = false; } finally { await browser.close(); srv.close(); }
process.exit(ok ? 0 : 1);
