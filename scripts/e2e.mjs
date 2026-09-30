// End-to-end check of the real UI in headless Chromium: import -> edit -> histogram ->
// undo/redo -> reset -> reload persistence -> before/after -> unsupported RAW message.
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
mkdirSync('scripts/.out', { recursive: true });
const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5198/');

  // Build a test photo in-page (sky gradient, warm ground, coloured blocks) and export as JPEG.
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 480); sky.addColorStop(0, '#2a5fae'); sky.addColorStop(1, '#d9e6f2');
    g.fillStyle = sky; g.fillRect(0, 0, 1200, 480);
    const ground = g.createLinearGradient(0, 480, 0, 800); ground.addColorStop(0, '#8a6a3c'); ground.addColorStop(1, '#2a1d0e');
    g.fillStyle = ground; g.fillRect(0, 480, 1200, 320);
    [['#c83232', 150], ['#32a852', 400], ['#3250c8', 650], ['#e8c832', 900]].forEach(([col, x]) => { g.fillStyle = col; g.fillRect(x, 520, 180, 180); });
    g.fillStyle = '#808080'; g.fillRect(1100, 100, 60, 60);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; buf.forEach((v) => (s += String.fromCharCode(v)));
    return btoa(s);
  });
  const jpg = Buffer.from(b64, 'base64');

  await page.setInputFiles('input[type=file]', { name: 'test-scene.jpg', mimeType: 'image/jpeg', buffer: jpg });
  await page.waitForSelector('.thumb.current');
  await page.waitForTimeout(600);
  check('photo imported and shown in filmstrip', (await page.locator('.thumb').count()) === 1);

  // Sum of pixel values of the on-screen canvas, from a real element screenshot.
  const shot = async () => {
    const png = await page.locator('[data-testid=viewer-canvas]').screenshot();
    return page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const t = document.createElement('canvas'); t.width = 96; t.height = 64; const x = t.getContext('2d');
      x.drawImage(bmp, 0, 0, 96, 64); const d = x.getImageData(0, 0, 96, 64).data;
      let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s;
    }, png.toString('base64'));
  };
  // Orientation: the test scene has a blue sky on top and brown ground at the bottom.
  const png0 = await page.locator('[data-testid=viewer-canvas]').screenshot();
  const rows = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const t = document.createElement('canvas'); t.width = bmp.width; t.height = bmp.height; const x = t.getContext('2d'); x.drawImage(bmp, 0, 0);
    const px = (yy) => Array.from(x.getImageData(Math.round(bmp.width * 0.05), yy, 1, 1).data);
    return { top: px(4), bottom: px(bmp.height - 5) };
  }, png0.toString('base64'));
  check('image is upright (sky on top, ground at bottom)', rows.top[2] > rows.top[0] && rows.bottom[0] > rows.bottom[2], JSON.stringify(rows));
  const base = await shot();
  check('canvas renders non-blank', base > 1000, `sum=${base}`);

  const setSlider = async (name, value) => {
    const input = page.locator(`.slider[data-param=${name}] .slider-number`);
    await input.fill(String(value)); await input.press('Enter'); await page.waitForTimeout(150);
  };

  await setSlider('exposure', 1);
  const bright = await shot();
  check('Exposure +1 brightens the rendered canvas', bright > base * 1.1, `${base} -> ${bright}`);

  // Dragging a real range input: one history entry per gesture.
  const before = await page.locator('.history-list li').count();
  const range = page.locator('.slider[data-param=contrast] .slider-range');
  const box = await range.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.5 + i * 0.03), box.y + box.height / 2);
  await page.mouse.up(); await page.waitForTimeout(200);
  const contrastVal = await page.locator('.slider[data-param=contrast] .slider-number').inputValue();
  check('dragging Contrast slider changes its value', parseInt(contrastVal) > 20, `contrast=${contrastVal}`);
  check('a whole drag is ONE history entry', (await page.locator('.history-list li').count()) === before + 1);

  // Keyboard adjust + double-click reset
  await setSlider('saturation', 0);
  await page.locator('.slider[data-param=saturation] .slider-range').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  check('keyboard arrows adjust (Shift = 10×)', (await page.locator('.slider[data-param=saturation] .slider-number').inputValue()) === '+12');
  await page.locator('.slider[data-param=saturation] .slider-label').dblclick();
  check('double-click resets a slider', (await page.locator('.slider[data-param=saturation] .slider-number').inputValue()) === '0');

  // Histogram is real: exposure moves the clipping numbers / shape; shadows up shifts.
  const clipText1 = await page.locator('.clip-toggle').innerText();
  await setSlider('exposure', 4);
  const clipText2 = await page.locator('.clip-toggle').innerText();
  check('histogram updates from rendered output (clipping rises at +4 EV)', clipText1 !== clipText2, `${clipText1.replace(/\s+/g, ' ')} -> ${clipText2.replace(/\s+/g, ' ')}`);
  await setSlider('exposure', 1);

  // White balance: Auto and eyedropper
  const tempBefore = await page.locator('.slider[data-param=temperature] .slider-number').inputValue();
  await page.getByRole('button', { name: 'Auto' }).click(); await page.waitForTimeout(200);
  const tempAuto = await page.locator('.slider[data-param=temperature] .slider-number').inputValue();
  check('Auto white balance sets Temp/Tint', tempBefore !== tempAuto, `temp ${tempBefore} -> ${tempAuto}`);
  await page.getByRole('button', { name: /Pick neutral/ }).click();
  const cv = await page.locator('[data-testid=viewer-canvas]').boundingBox();
  await page.mouse.click(cv.x + cv.width * (1130 / 1200), cv.y + cv.height * (130 / 800)); // the grey square
  await page.waitForTimeout(200);
  const labels = await page.locator('.history-list li').allInnerTexts();
  check('eyedropper on grey square records "White Balance Picker"', labels.includes('White Balance Picker'), labels[0]);

  await page.screenshot({ path: 'scripts/.out/editor.png' });

  // Undo / redo via keyboard
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const hist = () => page.locator('.history-list li button.current').innerText();
  const top = await hist();
  await page.keyboard.press('Control+z');
  const afterUndo = await hist();
  check('Ctrl+Z undoes (history pointer moves)', top !== afterUndo, `${top} -> ${afterUndo}`);
  await page.keyboard.press('Control+Shift+z');
  check('Ctrl+Shift+Z redoes', (await hist()) === top);

  // Before/after
  const edited = await shot();
  await page.keyboard.press('\\'); await page.waitForTimeout(200);
  const orig = await shot();
  check('Before (\\) shows the original render', orig !== edited && (await page.locator('.badge').innerText()) === 'Original');
  await page.keyboard.press('\\'); await page.waitForTimeout(200);

  // Reset all returns to exactly the original render
  await page.getByRole('button', { name: 'Reset All' }).click(); await page.waitForTimeout(250);
  const reset = await shot();
  check('Reset All renders identical to the untouched original', reset === base, `${reset} vs ${base}`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  check('…and Undo brings the edits back', (await shot()) !== base);

  // Persistence: edits survive a reload; original bytes intact
  await page.waitForTimeout(700);
  const savedExposure = await page.locator('.slider[data-param=exposure] .slider-number').inputValue();
  await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(700);
  check('edits persist across reload', (await page.locator('.slider[data-param=exposure] .slider-number').inputValue()) === savedExposure, `exposure ${savedExposure}`);
  const origOk = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('roomlight'); q.onsuccess = () => r(q.result); });
    const rec = await new Promise((r) => { const q = db.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => r(q.result[0]); });
    return rec.original.size;
  });
  check('stored original is byte-identical in size to the imported file', origOk === jpg.length, `${origOk} vs ${jpg.length}`);

  // RAW is refused honestly
  await page.setInputFiles('input[type=file]', { name: 'IMG_0001.CR3', mimeType: 'application/octet-stream', buffer: Buffer.from('not really raw') });
  await page.waitForSelector('.toast');
  check('RAW files are rejected with an explicit message', /RAW decoder/.test(await page.locator('.toast').first().innerText()));

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(e); results.push(false);
} finally {
  await browser.close(); await server.close();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\nE2E: ${failed} FAILED` : `\nE2E: all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
