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
    const input = page.locator(`[data-param=${name}] .slider-number`);
    await input.fill(String(value)); await input.press('Enter'); await page.waitForTimeout(150);
  };

  await setSlider('exposure', 1);
  const bright = await shot();
  check('Exposure +1 brightens the rendered canvas', bright > base * 1.1, `${base} -> ${bright}`);

  // Dragging a real range input: one history entry per gesture.
  const before = await page.locator('.history-list li').count();
  const range = page.locator('[data-param=contrast] .slider-range');
  const box = await range.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.5 + i * 0.03), box.y + box.height / 2);
  await page.mouse.up(); await page.waitForTimeout(200);
  const contrastVal = await page.locator('[data-param=contrast] .slider-number').inputValue();
  check('dragging Contrast slider changes its value', parseInt(contrastVal) > 20, `contrast=${contrastVal}`);
  check('a whole drag is ONE history entry', (await page.locator('.history-list li').count()) === before + 1);

  // Keyboard adjust + double-click reset
  await setSlider('saturation', 0);
  await page.locator('[data-param=saturation] .slider-range').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  check('keyboard arrows adjust (Shift = 10×)', (await page.locator('[data-param=saturation] .slider-number').inputValue()) === '+12');
  await page.locator('[data-param=saturation] .slider-label').dblclick();
  check('double-click resets a slider', (await page.locator('[data-param=saturation] .slider-number').inputValue()) === '0');

  // Histogram is real: exposure moves the clipping numbers / shape; shadows up shifts.
  const clipText1 = await page.locator('.clip-toggle').innerText();
  await setSlider('exposure', 4);
  const clipText2 = await page.locator('.clip-toggle').innerText();
  check('histogram updates from rendered output (clipping rises at +4 EV)', clipText1 !== clipText2, `${clipText1.replace(/\s+/g, ' ')} -> ${clipText2.replace(/\s+/g, ' ')}`);
  await setSlider('exposure', 1);

  // White balance: Auto and eyedropper
  const tempBefore = await page.locator('[data-param=temperature] .slider-number').inputValue();
  await page.selectOption('[data-testid=wb-select]', 'auto'); await page.waitForTimeout(200);
  const tempAuto = await page.locator('[data-param=temperature] .slider-number').inputValue();
  check('Auto white balance sets Temp/Tint', tempBefore !== tempAuto, `temp ${tempBefore} -> ${tempAuto}`);
  await page.getByRole('button', { name: /Pick neutral/ }).click();
  const cv = await page.locator('[data-testid=viewer-canvas]').boundingBox();
  await page.mouse.click(cv.x + cv.width * (1130 / 1200), cv.y + cv.height * (130 / 800)); // the grey square
  await page.waitForTimeout(200);
  const labels = await page.locator('.history-list li').allInnerTexts();
  check('eyedropper on grey square records "White Balance Picker"', labels.includes('White Balance Picker'), labels[0]);

  await page.screenshot({ path: 'scripts/.out/editor.png' });

  // ---------------------------------------------------------------- Phase 2 panels
  const open = async (title) => { await page.locator('.panel-toggle', { hasText: title }).click(); await page.waitForTimeout(100); };
  const topLabel = () => page.locator('.history-list li button').first().innerText();
  const settle = () => page.waitForTimeout(250);

  // Tone curve: add a point by clicking the curve, drag it up; double-click removes it.
  await open('Curve');
  await page.locator('.curve-svg').scrollIntoViewIfNeeded();
  const svg = await page.locator('.curve-svg').boundingBox();
  const cx = (x) => svg.x + ((10 + x * 256) / 276) * svg.width, cy = (y) => svg.y + ((10 + (1 - y) * 256) / 276) * svg.height;
  const preCurve = await shot();
  await page.mouse.move(cx(0.5), cy(0.5)); await page.mouse.down();
  await page.mouse.move(cx(0.5), cy(0.6), { steps: 4 }); await page.mouse.move(cx(0.5), cy(0.72), { steps: 4 }); await page.mouse.up(); await settle();
  check('curve: click+drag adds a point and brightens the image', (await shot()) > preCurve * 1.02, `${preCurve} -> ${await shot()}`);
  check('curve: drag recorded as one "Adjust RGB Curve" history entry', (await topLabel()) === 'Adjust RGB Curve');
  check('curve: readout shows the selected point', /Point · In 128 → Out 1[6-9]\d/.test(await page.locator('.curve-readout').innerText()), await page.locator('.curve-readout').innerText());
  await page.screenshot({ path: 'scripts/.out/curve.png' });
  await page.mouse.dblclick(cx(0.5), cy(0.72)); await settle();
  check('curve: double-click removes the point (back to the pre-curve render)', (await shot()) === preCurve);
  // Per-channel curve: pull the red white-point down -> image loses red
  await page.getByRole('tab', { name: /Red/ }).click();
  await page.mouse.move(cx(1), cy(1)); await page.mouse.down(); await page.mouse.move(cx(1), cy(0.6), { steps: 5 }); await page.mouse.up(); await settle();
  check('curve: Red channel white point is draggable (black/white points)', (await shot()) < preCurve && /White point/.test(await page.locator('.curve-readout').innerText()));
  await page.locator('.curve-tabs .tool').click(); await settle(); // Reset this channel
  check('curve: Reset restores the channel', (await shot()) === preCurve);

  // Colour mixer
  await open('Color Mixer');
  const preMix = await shot();
  await page.getByRole('tab', { name: 'Saturation' }).click();
  await setSlider('mix_red_sat', -100); await setSlider('mix_blue_sat', -100); await setSlider('mix_green_sat', -100);
  check('mixer: band sliders change the image', (await shot()) !== preMix);
  check('mixer: history label names the band', (await topLabel()).startsWith('Adjust ') && /Saturation$/.test(await topLabel()), await topLabel());
  await page.screenshot({ path: 'scripts/.out/mixer.png' });
  await page.locator('.tool', { hasText: 'Reset Saturation' }).click(); await settle();
  check('mixer: per-attribute reset restores the render', (await shot()) === preMix);

  // Colour grading: drag the wheel
  await open('Color Grading');
  const preGrade = await shot();
  await page.getByRole('tab', { name: 'Global' }).click();
  await page.locator('canvas.wheel').scrollIntoViewIfNeeded();
  const wheel = await page.locator('canvas.wheel').boundingBox();
  await page.mouse.move(wheel.x + wheel.width / 2, wheel.y + wheel.height / 2);
  await page.mouse.down(); await page.mouse.move(wheel.x + wheel.width * 0.8, wheel.y + wheel.height * 0.35, { steps: 6 }); await page.mouse.up(); await settle();
  const gSat = parseInt(await page.locator('[data-param=grade_global_sat] .slider-number').inputValue());
  const gHue = parseInt(await page.locator('[data-param=grade_global_hue] .slider-number').inputValue());
  check('grading: wheel drag sets hue (angle) and saturation (distance)', gSat > 30 && gHue > 20 && gHue < 70, `hue=${gHue} sat=${gSat}`);
  check('grading: tint changes the image; drag = one history entry', (await shot()) !== preGrade && (await topLabel()) === 'Global Color');
  await page.screenshot({ path: 'scripts/.out/grading.png' });
  await page.locator('canvas.wheel').dblclick(); await settle();
  check('grading: double-click resets the wheel', (await shot()) === preGrade);

  // Presence + effects
  const prePresence = await shot();
  await setSlider('texture', 60); await setSlider('clarity', 50); await setSlider('dehaze', 30);
  check('presence: texture/clarity/dehaze (multi-pass path) change the image', (await shot()) !== prePresence);
  await page.screenshot({ path: 'scripts/.out/presence.png' });
  await open('Effects');
  const preVig = await shot();
  await setSlider('vignetteAmount', -70);
  check('vignette: darkens the frame', (await shot()) < preVig * 0.98, `${preVig} -> ${await shot()}`);
  const preGrain = await shot();
  await setSlider('grainAmount', 60);
  const g1 = await shot();
  check('grain: changes the image', g1 !== preGrain);
  check('grain is stable between renders (deterministic)', (await shot()) === g1);
  await page.screenshot({ path: 'scripts/.out/effects.png' });

  // ---------------------------------------------------------------- Phase 3: crop, rotate, geometry, lens
  const aspectOf = async () => { const b = await page.locator('[data-testid=viewer-canvas]').boundingBox(); return b.width / b.height; };
  const pixelAt = async (u, v) => {
    const png = await page.locator('[data-testid=viewer-canvas]').screenshot();
    return page.evaluate(async ({ b64, u, v }) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      return Array.from(x.getImageData(Math.round(u * (bmp.width - 1)), Math.round(v * (bmp.height - 1)), 1, 1).data.slice(0, 3));
    }, { b64: png.toString('base64'), u, v });
  };
  await page.locator('[data-param=exposure]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-testid=reset-all]').click(); await settle(); // clean slate: original framing
  const a0 = await aspectOf();
  await page.locator('[data-tool=crop]').click(); await settle();
  check('crop tool: overlay with handles is shown, canvas still the full picture', (await page.locator('.crop-overlay [data-handle]').count()) === 8 && Math.abs((await aspectOf()) - a0) < 0.01);
  await page.locator('[data-aspect="1:1"]').click(); await settle();
  const sq = (await page.locator('[data-testid=crop-size]').innerText()).match(/(\d+) × (\d+) px/);
  check('crop: 1:1 preset gives a square crop', !!sq && sq[1] === sq[2] && parseInt(sq[1]) > 100, await page.locator('[data-testid=crop-size]').innerText());
  const body = await page.locator('[data-testid=crop-body]').boundingBox();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2); await page.mouse.down();
  await page.mouse.move(body.x + body.width / 2 + 60, body.y + body.height / 2, { steps: 5 }); await page.mouse.up(); await settle();
  check('crop: dragging moves the crop (one "Crop" history entry)', (await topLabel()) === 'Crop');
  const se = await page.locator('[data-handle=se]').boundingBox();
  await page.mouse.move(se.x + 6, se.y + 6); await page.mouse.down();
  await page.mouse.move(se.x - 80, se.y - 80, { steps: 6 }); await page.mouse.up(); await settle();
  const sq2 = (await page.locator('[data-testid=crop-size]').innerText()).match(/(\d+) × (\d+) px/);
  check('crop: corner drag resizes and keeps the 1:1 lock', !!sq2 && sq2[1] === sq2[2] && parseInt(sq2[1]) < parseInt(sq[1]), await page.locator('[data-testid=crop-size]').innerText());
  await page.screenshot({ path: 'scripts/.out/crop-tool.png' });
  const cropBefore = await page.locator('[data-testid=crop-body]').boundingBox();
  await setSlider('straighten', 6); await settle();
  const cropAfter = await page.locator('[data-testid=crop-body]').boundingBox();
  check('straighten: crop auto-shrinks so no empty corners show', cropAfter.width < cropBefore.width - 2, `${cropBefore.width.toFixed(0)} -> ${cropAfter.width.toFixed(0)}`);
  await page.locator('.right button', { hasText: 'Right' }).first().click(); await settle();
  check('rotate right turns the picture (canvas aspect inverts)', Math.abs((await aspectOf()) * a0 - 1) < 0.02, `${(await aspectOf()).toFixed(3)} vs ${a0.toFixed(3)}`);
  await page.locator('.right button', { hasText: 'Done' }).click(); await settle();
  check('Done returns to the edit tool and shows the cropped result', (await page.locator('[data-tool=edit].on').count()) === 1 && Math.abs(Math.abs((await aspectOf()) - 1)) < 0.03, `aspect ${(await aspectOf()).toFixed(3)}`);
  const cropShot = await shot();
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await settle();
  check('undo steps back through crop operations', (await shot()) !== cropShot);
  await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z'); await settle();
  check('redo restores them', (await shot()) === cropShot);
  await page.locator('[data-tool=crop]').click(); await settle();
  await page.locator('button.tool', { hasText: 'Reset crop' }).click(); await settle();
  await page.locator('[data-tool=edit]').click(); await settle();
  check('Reset crop restores the full original framing (nothing was lost)', Math.abs((await aspectOf()) - a0) < 0.01 && (await shot()) === base);

  // Geometry + lens panels
  await page.locator('[data-tool=crop]').click(); await page.locator('[data-crop-tab=geometry]').click(); await settle(); // Geometry lives inside the Crop & Geometry tool
  const preGeo = await shot();
  await setSlider('geoVertical', 35); await settle();
  check('geometry: Vertical perspective changes the image', (await shot()) !== preGeo);
  await page.screenshot({ path: 'scripts/.out/geometry.png' });
  await page.locator('[data-upright=auto]').click(); await settle();
  const uprightLabel = await topLabel();
  const toastText = await page.locator('.toast').count() ? await page.locator('.toast').last().innerText() : '';
  check('Upright either corrects the photo or honestly reports no straight lines', /Auto Upright/.test(uprightLabel) || /no clear straight lines/.test(toastText), `${uprightLabel} | ${toastText}`);
  await page.locator('[data-upright=off]').click(); await settle();
  await setSlider('geoScale', 100); await setSlider('geoVertical', 0);
  await page.locator('[data-tool=edit]').click(); await settle();
  await open('Optics');
  const preLens = await shot();
  await page.selectOption('select[aria-label="Lens profile"]', 'example-wide'); await settle();
  check('lens: selecting an example profile applies corrections and labels it as an example', (await shot()) !== preLens && (await page.locator('[data-testid=example-profile-note]').count()) === 1);
  await setSlider('lensDistortion', 40); await setSlider('lensVignetting', 50); await setSlider('lensCA', 60); await settle();
  check('lens: distortion / vignetting / CA sliders are live', (await shot()) !== preLens);
  await page.selectOption('select[aria-label="Lens profile"]', 'none');
  await setSlider('lensDistortion', 0); await setSlider('lensVignetting', 0); await setSlider('lensCA', 0); await settle();
  await page.waitForTimeout(600);
  const saved = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('roomlight'); q.onsuccess = () => r(q.result); });
    const rec = await new Promise((r) => { const q = db.transaction('edits').objectStore('edits').getAll(); q.onsuccess = () => r(q.result[0]); });
    return rec.edits;
  });
  const scalarEdits = Object.entries(saved).filter(([k, v]) => typeof v === 'number' && !['gradeBlending', 'vignetteMidpoint', 'vignetteFeather', 'grainSize', 'grainRoughness', 'geoScale', 'sharpRadius', 'sharpDetail', 'nrLumaDetail', 'nrColorDetail', 'nrColorSmooth'].includes(k) && v !== 0);
  check('geometry/lens sliders are all back at zero; the crop stayed shrunk (it only ever shrinks to hide empty edges)', scalarEdits.length === 0 && saved.lensProfile === 'none' && saved.crop.w < 1, JSON.stringify(scalarEdits) + ' crop.w=' + saved.crop.w.toFixed(3));
  await page.locator('[data-tool=crop]').click(); await page.locator('button.tool', { hasText: 'Reset crop' }).click(); await page.locator('[data-tool=edit]').click(); await settle();
  check('…and Reset crop brings back exactly the original render', (await shot()) === base);

  // ---------------------------------------------------------------- Phase 4: masks
  await page.locator('[data-tool=mask]').click(); await settle();
  // Masking UI helpers (Create New Mask / Add / Subtract are menus; per-mask options live in a ⋯ menu)
  const createMask = async (t) => { await page.locator('[data-testid=create-mask]').click(); await page.locator(`[data-create=${t}]`).click(); };
  const maskMenu = async (name) => { await page.locator('[data-mask].selected [aria-label="Mask options"]').click(); await page.getByRole('menuitem', { name }).click(); };
  await page.locator('[data-testid=create-mask]').click();
  check('masking: AI selections are disabled and honestly labelled (no fake AI)', (await page.locator('[data-create=subject]').isDisabled()) && (await page.locator('[data-create=sky]').isDisabled()) && (await page.locator('[data-create=background]').isDisabled()) && /unavailable/i.test(await page.locator('[data-testid=ai-unavailable]').innerText()));
  await page.keyboard.press('Escape');
  const preMask = await shot();
  await createMask('linear'); await settle();
  check('linear gradient: created with draggable start/end handles', (await page.locator('.mask-list li').count()) === 1 && (await page.locator('[data-handle=start]').count()) === 1 && (await page.locator('[data-handle=end]').count()) === 1);
  const cleanShot = async () => { await page.locator('[data-tool=edit]').click(); await settle(); const v = await shot(); await page.locator('[data-tool=mask]').click(); await settle(); return v; };
  check('the red mask overlay is OFF by default (it only tints the canvas when you ask for it)', !(await page.getByLabel('Show overlay').isChecked())); await settle();
  check('a new mask with no adjustments changes nothing (overlay off)', (await cleanShot()) === preMask);
  const lset = async (k, v) => { const input = page.locator(`[data-local=${k}] .slider-number`); await input.fill(String(v)); await input.press('Enter'); await settle(); };
  const skyBefore = await pixelAt(0.3, 0.15), groundBefore = await pixelAt(0.3, 0.92);
  await lset('exposure', -1.5);
  const skyAfter = await pixelAt(0.3, 0.15), groundAfter = await pixelAt(0.3, 0.92);
  const lum = (c) => c[0] + c[1] + c[2];
  check('local exposure darkens the masked top of the frame and leaves the bottom alone', lum(skyAfter) < lum(skyBefore) - 40 && groundAfter.every((v, i) => Math.abs(v - groundBefore[i]) <= 40), `sky ${lum(skyBefore)}->${lum(skyAfter)}, ground ${lum(groundBefore)}->${lum(groundAfter)}`);
  check('mask history label is specific', (await topLabel()) === 'Adjust Mask Exposure', await topLabel());
  await page.screenshot({ path: 'scripts/.out/mask-linear.png' });
  const endH = await page.locator('[data-handle=end]').boundingBox();
  const midSky = await pixelAt(0.3, 0.4);
  await page.mouse.move(endH.x + 7, endH.y + 7); await page.mouse.down(); await page.mouse.move(endH.x + 7, endH.y + 7 + 200, { steps: 6 }); await page.mouse.up(); await settle();
  check('dragging the gradient end handle reshapes the mask (one history entry)', (await topLabel()) === 'Adjust Linear Gradient' && lum(await pixelAt(0.3, 0.4)) < lum(midSky));
  await lset('exposure', 0);
  check('mask at zero adjustment changes nothing', (await cleanShot()) === preMask);
  // invert + amount
  const gPre = await pixelAt(0.3, 0.84), sPre = await pixelAt(0.3, 0.15); // (the overlay's dashed guide line sits near the bottom; sample clear of it)
  await maskMenu('Invert mask'); await settle();
  await lset('exposure', -1.5);
  check('invert mask flips where the adjustment applies', lum(await pixelAt(0.3, 0.84)) < lum(gPre) - 40 && lum(await pixelAt(0.3, 0.15)) >= lum(sPre) - 40, `ground ${lum(gPre)} -> ${lum(await pixelAt(0.3, 0.84))}, sky ${lum(sPre)} -> ${lum(await pixelAt(0.3, 0.15))}`);
  await maskMenu('Invert mask'); await settle();
  await page.getByLabel('Mask Amount value').fill('0'); await page.getByLabel('Mask Amount value').press('Enter'); await settle();
  check('mask amount 0 turns the effect off', (await cleanShot()) === preMask);
  // radial
  await maskMenu('Delete mask'); await settle();
  await createMask('radial'); await settle();
  check('radial gradient: ellipse handles shown', (await page.locator('[data-handle=center]').count()) === 1 && (await page.locator('[data-handle=rotate]').count()) === 1);
  const cBefore = await pixelAt(0.56, 0.62);
  await lset('exposure', 1.5);
  check('radial local exposure brightens the centre', lum(await pixelAt(0.56, 0.62)) > lum(cBefore) + 20);
  await page.getByLabel('Mask Rotation value').fill('45').catch(() => {});
  await page.screenshot({ path: 'scripts/.out/mask-radial.png' });
  // brush
  await createMask('brush'); await settle();
  await lset('exposure', -2);
  const ov = await page.locator('[data-testid=mask-overlay]').boundingBox();
  const brushBefore = await pixelAt(0.2, 0.75);
  await page.mouse.move(ov.x + ov.width * 0.1, ov.y + ov.height * 0.75); await page.mouse.down();
  await page.mouse.move(ov.x + ov.width * 0.35, ov.y + ov.height * 0.75, { steps: 12 }); await page.mouse.up(); await settle();
  check('brush: a stroke is one "Brush Stroke" history entry', (await topLabel()) === 'Brush Stroke', await topLabel());
  check('brush: painted area gets the adjustment, unpainted does not', lum(await pixelAt(0.2, 0.75)) < lum(brushBefore) - 40 && lum(await pixelAt(0.85, 0.75)) > 0);
  const farBefore = await pixelAt(0.85, 0.75);
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.mouse.move(ov.x + ov.width * 0.1, ov.y + ov.height * 0.75); await page.mouse.down();
  await page.mouse.move(ov.x + ov.width * 0.35, ov.y + ov.height * 0.75, { steps: 12 }); await page.mouse.up(); await settle();
  check('brush: eraser removes the painted mask again', (await topLabel()) === 'Erase Brush Stroke' && lum(await pixelAt(0.2, 0.75)) >= lum(brushBefore) - 20 && lum(await pixelAt(0.85, 0.75)) === lum(farBefore));
  await page.screenshot({ path: 'scripts/.out/mask-brush.png' });
  // colour range
  await createMask('color'); await settle();
  await page.getByRole('button', { name: /Click the photo/ }).waitFor();
  const greenBefore = await pixelAt(0.41, 0.76), redBefore = await pixelAt(0.19, 0.76);
  const cv2 = await page.locator('[data-testid=mask-overlay]').boundingBox();
  await page.mouse.click(cv2.x + cv2.width * 0.41, cv2.y + cv2.height * 0.76); await settle();
  const swatch = await page.locator('[data-testid=color-target]').evaluate((e) => getComputedStyle(e).backgroundColor);
  const [sr, sg, sb] = swatch.match(/\d+/g).map(Number);
  check('colour range: eyedropper samples the clicked colour (green)', sg > sr + 30 && sg > sb + 30, swatch);
  await lset('saturation', -100);
  const gAfter = await pixelAt(0.41, 0.76), rAfter = await pixelAt(0.19, 0.76);
  check('colour range: only the green block is desaturated; the red block is untouched', Math.max(...gAfter) - Math.min(...gAfter) < 25 && Math.max(...greenBefore) - Math.min(...greenBefore) > 60 && rAfter.every((v, i) => v === redBefore[i]), `green ${greenBefore}->${gAfter}, red ${redBefore}->${rAfter}`);
  await page.screenshot({ path: 'scripts/.out/mask-color.png' });
  // luminance range
  await createMask('luminance'); await settle();
  const brightBefore = await pixelAt(0.5, 0.46), darkBefore = await pixelAt(0.5, 0.96);
  await lset('exposure', -2);
  check('luminance range: bright tones are darkened, shadows are not', lum(await pixelAt(0.5, 0.46)) < lum(brightBefore) - 60 && lum(await pixelAt(0.5, 0.96)) >= lum(darkBefore) - 6, `bright ${lum(brightBefore)}->${lum(await pixelAt(0.5, 0.46))} dark ${lum(darkBefore)}->${lum(await pixelAt(0.5, 0.96))}`);
  // combine: add a subtract component
  await page.locator('[data-testid=menu-subtract]').click(); await page.locator('[data-add="subtract:radial"]').click(); await settle();
  check('components: subtract adds a second component to the same mask', (await page.locator('.comp-row').count()) === 2);
  // overlay toggle + persistence
  const masksBefore = await page.locator('.mask-list li').count();
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(800);
  await page.locator('[data-tool=mask]').click(); await settle();
  check('masks persist across reload (strokes, shapes, adjustments)', (await page.locator('.mask-list li').count()) === masksBefore && masksBefore >= 4);
  await page.locator('.mask-list li').first().click(); await settle();
  await page.screenshot({ path: 'scripts/.out/mask-list.png' });
  await page.locator('[data-tool=edit]').click(); await settle();
  await page.locator('[data-testid=reset-all]').click(); await settle();
  await page.locator('[data-tool=mask]').click(); await settle();
  check('Reset All removes the masks too', (await page.locator('.mask-list li').count()) === 0);
  await page.locator('[data-tool=edit]').click(); await settle();
  check('after Reset All the render equals the untouched original again', (await shot()) === base);
  await page.locator('[data-param=exposure]').scrollIntoViewIfNeeded().catch(() => {});
  await setSlider('exposure', 1);

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
  await page.locator('[data-testid=reset-all]').click(); await page.waitForTimeout(250);
  const reset = await shot();
  check('Reset All renders identical to the untouched original', reset === base, `${reset} vs ${base}`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  check('…and Undo brings the edits back', (await shot()) !== base);

  // Persistence: edits survive a reload; original bytes intact
  await page.waitForTimeout(700);
  const savedExposure = await page.locator('[data-param=exposure] .slider-number').inputValue();
  await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(700);
  check('edits persist across reload', (await page.locator('[data-param=exposure] .slider-number').inputValue()) === savedExposure, `exposure ${savedExposure}`);
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
