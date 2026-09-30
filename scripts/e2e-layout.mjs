// End-to-end checks for the Lightroom-style layout and the Detail panel (noise reduction + input sharpening).
import { createServer } from 'vite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
mkdirSync('scripts/.out', { recursive: true });
const server = await createServer({ server: { port: 5195, strictPort: true }, logLevel: 'error' });
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
  await page.goto('http://localhost:5195/');

  // ---- test photos -----------------------------------------------------------------------------------
  /** kind 'noisy': a hard vertical step (x=600) with luminance + colour noise. kind 'tilt': sky/ground split by a line tilted 6 degrees. */
  const photo = (kind) => page.evaluate(async (kind) => {
    const W = 1200, H = 800, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    if (kind === 'noisy') {
      const img = g.createImageData(W, H); let seed = 12345;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const base = x < 600 ? [90, 105, 120] : [175, 165, 150], n = gauss() * 9, cr = gauss() * 10, cb = gauss() * 10, o = (y * W + x) * 4;
        img.data[o] = base[0] + n + cr; img.data[o + 1] = base[1] + n; img.data[o + 2] = base[2] + n + cb; img.data[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    } else {
      g.fillStyle = '#6aa0e0'; g.fillRect(0, 0, W, H); g.fillStyle = '#3a2a1a';
      const t = Math.tan((6 * Math.PI) / 180); g.beginPath(); g.moveTo(0, 400 - 600 * t); g.lineTo(W, 400 + 600 * t); g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fill();
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.97)); const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; u.forEach((v) => (s += String.fromCharCode(v))); return btoa(s);
  }, kind);
  const importPhoto = async (name, kind) => {
    await page.setInputFiles('input[type=file]', { name, mimeType: 'image/jpeg', buffer: Buffer.from(await photo(kind), 'base64') });
    await page.waitForFunction((n) => document.querySelector('.file-name')?.textContent?.startsWith(n), name); await page.waitForTimeout(700);
  };
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const canvasPng = async () => page.locator('[data-testid=viewer-canvas]').screenshot();
  /** Pixel statistics of a region of the on-screen canvas (fractions), from a real element screenshot. */
  const stats = async (fx0, fy0, fx1, fy1) => page.evaluate(async ([b64, fx0, fy0, fx1, fy1]) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const x0 = Math.round(bmp.width * fx0), y0 = Math.round(bmp.height * fy0), w = Math.round(bmp.width * (fx1 - fx0)), h = Math.round(bmp.height * (fy1 - fy0));
    const d = g.getImageData(x0, y0, w, h).data; let n = 0, sl = 0, sl2 = 0, sa = 0, sa2 = 0, sb = 0, sb2 = 0;
    for (let i = 0; i < d.length; i += 4) { const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2], a = d[i] - d[i + 1], b = d[i + 2] - d[i + 1]; sl += L; sl2 += L * L; sa += a; sa2 += a * a; sb += b; sb2 += b * b; n++; }
    const ml = sl / n;
    return { lumaStd: Math.sqrt(sl2 / n - ml * ml), chromaStd: Math.sqrt(Math.max(0, sa2 / n - (sa / n) ** 2) + Math.max(0, sb2 / n - (sb / n) ** 2)), meanL: ml, w: bmp.width, h: bmp.height };
  }, [(await canvasPng()).toString('base64'), fx0, fy0, fx1, fy1]);
  /** Edge overshoot at the step at the canvas centre: how far the bright side's first pixels rise above its plateau. */
  const halo = async () => page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const cx = Math.round(bmp.width / 2), y0 = Math.round(bmp.height * 0.3), rows = Math.round(bmp.height * 0.4);
    const d = g.getImageData(cx - 40, y0, 80, rows).data; const col = (dx) => { let s = 0; for (let r = 0; r < rows; r++) { const i = (r * 80 + (40 + dx)) * 4; s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; } return s / rows; };
    let plateau = 0; for (let dx = 15; dx < 35; dx++) plateau += col(dx); plateau /= 20;
    let darkPlateau = 0; for (let dx = -35; dx < -15; dx++) darkPlateau += col(dx); darkPlateau /= 20;
    return { over: Math.max(col(1), col(2), col(3)) - plateau, under: darkPlateau - Math.min(col(-1), col(-2), col(-3)) };
  }, (await canvasPng()).toString('base64'));
  const settleDetail = async () => { await page.waitForTimeout(250); await page.locator('[data-testid=detail-busy]').waitFor({ state: 'hidden', timeout: 40000 }).catch(() => {}); await page.waitForTimeout(400); };
  const setSlider = async (name, v) => { const i = page.locator(`[data-param=${name}] .slider-number`); await i.fill(String(v)); await i.press('Enter'); await page.waitForTimeout(150); };
  const panelTitles = () => page.locator('.right .panel-toggle').allInnerTexts().then((a) => a.map((t) => t.replace(/[▸▾]/g, '').trim()));
  const openPanel = async (title) => { const t = page.locator('.right .panel-toggle', { hasText: new RegExp(`^\\s*[▸▾]?\\s*${title}\\s*$`) }).first(); if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click(); await page.waitForTimeout(100); };

  await importPhoto('noisy.jpg', 'noisy');

  // ======================================================================= LAYOUT
  const box = async (sel) => page.locator(sel).first().boundingBox();
  const vw = 1500;
  check('top bar: Library | Edit switch is the only navigation (no tool tabs up there)', (await page.locator('.topbar [data-mode]').count()) === 2 && (await page.locator('.topbar [data-tool]').count()) === 0);
  const modes = await page.locator('.topbar [data-mode]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mode')));
  const swBox = await box('.mode-switch'), nameBox = await box('[data-testid=file-name]'), undoBox = await box('.topbar button:has-text("Undo")'), expBox = await box('[data-testid=open-export]');
  check('top bar order: switch on the left, filename in the centre, Undo/Redo/Before-After/Export on the right', modes.join() === 'library,edit' && swBox.x < 300 && nameBox.x > 400 && nameBox.x + nameBox.width < 1100 && undoBox.x > 1000 && expBox.x + expBox.width > vw - 60, `${swBox.x} ${nameBox.x} ${undoBox.x}`);
  const rightBtns = await page.locator('.topbar > button').allInnerTexts();
  check('top bar right side holds exactly Undo, Redo, Before / After, Export', rightBtns.join('|') === 'Undo|Redo|Before / After|Export…', rightBtns.join('|'));

  const strip = await box('nav.tool-strip'), panelCol = await box('aside.right');
  check('tool strip is a thin vertical column on the FAR RIGHT edge, beside the panel column', strip.x + strip.width >= vw - 2 && strip.width < 70 && strip.height > strip.width * 3 && strip.x >= panelCol.x + panelCol.width - 2, JSON.stringify(strip));
  const toolIds = await page.locator('nav.tool-strip [data-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')));
  check('tools, top to bottom: Presets, Edit, Crop & Geometry, Healing / Remove, Masking', toolIds.join() === 'presets,edit,crop,retouch,mask');
  const ys = await page.locator('nav.tool-strip [data-tool]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
  check('…stacked vertically in that order', ys.every((y, i) => i === 0 || y > ys[i - 1]));
  check('Edit is the default tool and only one tool is active', (await page.locator('nav.tool-strip button.on').count()) === 1 && (await page.locator('[data-tool=edit].on').count()) === 1);

  const titles = await panelTitles();
  check('Edit panels, top to bottom: Basic, Curve, Color Mixer, Color Grading, Detail, Optics, Effects', titles.join('|') === 'Basic|Curve|Color Mixer|Color Grading|Detail|Optics|Effects', titles.join('|'));
  const leftTitles = await page.locator('aside.left .panel-toggle').allInnerTexts().then((a) => a.map((t) => t.replace(/[▸▾]/g, '').trim()));
  check('left panel: History, Snapshots (Presets moved to the tool strip)', leftTitles.slice(0, 2).join('|') === 'History|Snapshots' && !leftTitles.includes('Presets'), leftTitles.join('|'));
  check('Geometry (Upright, Transform) is NOT in the Edit panels', (await page.locator('.right [data-upright]').count()) === 0 && (await page.locator('.right [data-param=geoVertical]').count()) === 0 && !titles.includes('Geometry'));
  await openPanel('Effects'); await openPanel('Basic');
  check('Texture, Clarity and Dehaze appear once, in Basic > Presence', (await page.locator('[data-param=clarity]').count()) === 1 && (await page.locator('[data-param=texture]').count()) === 1 && (await page.locator('[data-param=dehaze]').count()) === 1);
  const basicKeys = await page.locator('.right .panel').first().locator('[data-param]').evaluateAll((els) => els.map((e) => e.getAttribute('data-param')));
  check('Basic holds WB, Tone, Presence (Texture, Clarity, Dehaze, Vibrance, Saturation) in order', basicKeys.join() === 'temperature,tint,exposure,contrast,highlights,shadows,whites,blacks,texture,clarity,dehaze,vibrance,saturation', basicKeys.join());
  const effectsKeys = await page.locator('.right .panel', { has: page.locator('.panel-toggle:has-text("Effects")') }).locator('[data-param]').evaluateAll((els) => els.map((e) => e.getAttribute('data-param')));
  check('Effects holds only Vignette and Grain (no Texture/Clarity/Dehaze)', effectsKeys.join() === 'vignetteAmount,vignetteMidpoint,vignetteRoundness,vignetteFeather,vignetteHighlights,grainAmount,grainSize,grainRoughness', effectsKeys.join());

  const cvBox = await box('[data-testid=viewer-canvas]'), tbBox = await box('.image-toolbar');
  check('image toolbar sits under the photo', tbBox.y >= cvBox.y + cvBox.height - 1);
  const tbBtns = await page.locator('.image-toolbar button').allInnerTexts();
  check('toolbar: Fit, Fill, 100%, 200%, Auto, B&W, Reset, Copy, Paste', tbBtns.join('|') === 'Fit|Fill|100%|200%|Auto|B&W|Reset|Copy|Paste', tbBtns.join('|'));
  const fsBox = await box('.filmstrip-wrap');
  check('filmstrip is at the bottom with thumbnails', fsBox.y > 700 && (await page.locator('.filmstrip [data-photo]').count()) === 1);
  const hb = await box('.histogram'), pb = await box('.right-scroll');
  check('histogram sits at the top of the panel column, above the tool panels', hb.y < pb.y && hb.x >= panelCol.x, `histogram y ${hb.y} panels y ${pb.y}`);

  // each tool swaps the panel column; the histogram stays
  const histVisible = async () => (await page.locator('.histogram canvas').isVisible());
  await page.locator('[data-tool=crop]').click(); await page.waitForTimeout(300);
  check('Crop & Geometry tool: panel column shows Crop | Geometry tabs, histogram stays', (await page.locator('[data-crop-tab=crop]').count()) === 1 && (await page.locator('[data-crop-tab=geometry]').count()) === 1 && (await histVisible()) && (await page.locator('[data-tool=crop].on').count()) === 1 && (await page.locator('[data-tool=edit].on').count()) === 0);
  await page.locator('[data-tool=retouch]').click(); await page.waitForTimeout(300);
  check('Healing / Remove tool: Remove, Heal, Clone + Size, Feather, Opacity + Show overlay', (await page.locator('[data-spot-kind]').evaluateAll((e) => e.map((x) => x.getAttribute('data-spot-kind'))).then((a) => a.sort().join())) === 'clone,heal,remove' && (await page.locator('[data-retouch]').count()) === 3 && (await page.locator('label.chk:has-text("Show spots")').count()) === 1 && (await histVisible()));
  await page.locator('[data-tool=mask]').click(); await page.waitForTimeout(300);
  check('Masking tool: a single Create New Mask button (no grid of buttons), histogram stays', (await page.locator('[data-testid=create-mask]').count()) === 1 && (await page.locator('[data-create]').count()) === 0 && (await histVisible()));
  await page.locator('[data-tool=edit]').click(); await page.waitForTimeout(300);
  check('clicking Edit returns to the normal panels', (await panelTitles()).includes('Basic'));
  check('the Healing tool is not inside any Edit panel', (await page.locator('.right [data-spot-kind]').count()) === 0);

  // ======================================================================= DETAIL (at 100 % so canvas pixels = image pixels)
  await page.locator('[data-zoom-btn="100"]').click(); await page.waitForTimeout(800);
  await openPanel('Detail');
  const flat0 = await stats(0.1, 0.2, 0.4, 0.8), h0 = await halo();
  check('Detail panel: Sharpening (Amount, Radius, Detail, Masking) and Noise Reduction (Luminance, Detail, Contrast, Color, Detail, Smoothness)', (await page.locator('.right .panel', { has: page.locator('.panel-toggle:has-text("Detail")') }).locator('[data-param]').evaluateAll((e) => e.map((x) => x.getAttribute('data-param'))).then((a) => a.join())) === 'sharpAmount,sharpRadius,sharpDetail,sharpMasking,nrLuma,nrLumaDetail,nrLumaContrast,nrColor,nrColorDetail,nrColorSmooth');

  await setSlider('nrLuma', 70); await setSlider('nrLumaDetail', 0); await settleDetail();
  const flat1 = await stats(0.1, 0.2, 0.4, 0.8);
  check('Luminance noise reduction removes most of the luminance noise', flat1.lumaStd < flat0.lumaStd * 0.5, `std ${flat0.lumaStd.toFixed(1)} -> ${flat1.lumaStd.toFixed(1)}`);
  const hNR = await halo();
  check('…and the hard edge stays sharp (edge-preserving)', hNR.over > -6 && Math.abs(hNR.over - h0.over) < 12, `${JSON.stringify(h0)} -> ${JSON.stringify(hNR)}`);
  await setSlider('nrColor', 100); await settleDetail();
  const flat2 = await stats(0.1, 0.2, 0.4, 0.8);
  check('Colour noise reduction removes colour speckle', flat2.chromaStd < flat1.chromaStd * 0.6, `chroma std ${flat1.chromaStd.toFixed(1)} -> ${flat2.chromaStd.toFixed(1)}`);
  await page.screenshot({ path: 'scripts/.out/detail-nr.png' });
  await page.locator('.right .panel', { has: page.locator('.panel-toggle:has-text("Detail")') }).locator('.panel-reset').click(); await settleDetail();
  const flat3 = await stats(0.1, 0.2, 0.4, 0.8);
  check('resetting Detail brings the original pixels back exactly', Math.abs(flat3.lumaStd - flat0.lumaStd) < 0.3 && Math.abs(flat3.chromaStd - flat0.chromaStd) < 0.3, `${flat0.lumaStd.toFixed(2)} vs ${flat3.lumaStd.toFixed(2)}`);

  await setSlider('nrLuma', 60); await setSlider('nrLumaDetail', 0); await settleDetail(); // calm the noise so the edge halo is measurable
  const hBase = await halo();
  await setSlider('sharpAmount', 120); await setSlider('sharpDetail', 100); await setSlider('sharpRadius', 1.5); await settleDetail();
  const hS = await halo();
  check('Sharpening adds an overshoot halo on both sides of an edge', hS.over > hBase.over + 4 && hS.under > hBase.under + 4, `over ${hBase.over.toFixed(1)} -> ${hS.over.toFixed(1)}, under ${hBase.under.toFixed(1)} -> ${hS.under.toFixed(1)}`);
  await setSlider('sharpDetail', 0); await settleDetail();
  const hSoft = await halo();
  check('Detail = 0 suppresses the halo (softer overshoot)', hSoft.over < hS.over * 0.8, `${hS.over.toFixed(1)} -> ${hSoft.over.toFixed(1)}`);
  await setSlider('sharpDetail', 100); await setSlider('sharpAmount', 0); await setSlider('nrLuma', 0); await settleDetail();

  // the same Detail is applied in the export (full-size file)
  await setSlider('nrLuma', 80); await setSlider('nrLumaDetail', 0); await settleDetail();
  await blur(); await page.keyboard.press('Control+Shift+E'); await page.locator('[role=dialog][aria-label=Export]').waitFor();
  await page.locator('select[aria-label=Format]').selectOption('png');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.locator('[data-testid=export-go]').click()]);
  await dl.saveAs('scripts/.out/detail-export.png'); await page.locator('[data-testid=export-done]').waitFor({ timeout: 60000 });
  const pngB64 = readFileSync('scripts/.out/detail-export.png').toString('base64');
  const expStd = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(100, 100, 300, 500).data; let n = 0, s = 0, s2 = 0; for (let i = 0; i < d.length; i += 4) { const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += L; s2 += L * L; n++; } return Math.sqrt(s2 / n - (s / n) ** 2);
  }, pngB64);
  check('the exported full-size file has the noise reduction baked in', expStd < flat0.lumaStd * 0.5, `export luma std ${expStd.toFixed(1)} vs original ${flat0.lumaStd.toFixed(1)}`);
  await page.locator('.dialog-foot button', { hasText: 'Close' }).click();
  await page.locator('.right .panel', { has: page.locator('.panel-toggle:has-text("Detail")') }).locator('.panel-reset').click(); await settleDetail();
  await page.locator('[data-zoom-btn="fit"]').click();

  // ======================================================================= EDIT panels: moved / new controls
  // White balance dropdown
  const wb = page.locator('[data-testid=wb-select]');
  check('White Balance has an As Shot / Auto / Custom dropdown, starting at As Shot', (await wb.inputValue()) === 'asShot' && (await wb.locator('option').allInnerTexts()).join('|') === 'As Shot|Auto|Custom');
  await wb.selectOption('auto'); await page.waitForTimeout(300);
  const tAuto = await page.locator('[data-param=temperature] .slider-number').inputValue();
  check('Auto sets Temperature/Tint and the dropdown says Auto', tAuto !== '0' && (await wb.inputValue()) === 'auto', `temp ${tAuto}`);
  await setSlider('temperature', 33);
  check('moving a slider switches the dropdown to Custom', (await wb.inputValue()) === 'custom');
  await wb.selectOption('asShot'); await page.waitForTimeout(250);
  check('As Shot puts Temperature and Tint back to 0', (await page.locator('[data-param=temperature] .slider-number').inputValue()) === '0' && (await page.locator('[data-param=tint] .slider-number').inputValue()) === '0');

  // Curve: Point | Parametric
  await openPanel('Curve');
  check('Curve has a Point Curve | Parametric Curve toggle; point mode has RGB/R/G/B', (await page.locator('[data-curve-mode]').count()) === 2 && (await page.locator('.curve-tabs button').allInnerTexts().then((a) => a.map((t) => t.trim()).join('|'))).includes('RGB'));
  await page.locator('[data-curve-mode=parametric]').click();
  const pk = await page.locator('.right [data-param^=curve]').evaluateAll((e) => e.map((x) => x.getAttribute('data-param')));
  check('Parametric mode: Highlights, Lights, Darks, Shadows', pk.join() === 'curveHighlights,curveLights,curveDarks,curveShadows', pk.join());
  const cBase = await stats(0.6, 0.2, 0.9, 0.8); // the bright half of the picture
  await setSlider('curveLights', 100); await page.waitForTimeout(300);
  const cHi = await stats(0.6, 0.2, 0.9, 0.8);
  check('a Parametric Curve slider really changes the bright tones', cHi.meanL > cBase.meanL + 2, `${cBase.meanL.toFixed(1)} -> ${cHi.meanL.toFixed(1)}`);
  await page.locator('[data-curve-mode=point]').click();
  check('switching back to Point Curve keeps the parametric setting and shows the curve editor', (await page.locator('.curve-editor').count()) === 1 && (await page.locator('[data-param=curveHighlights]').count()) === 0);
  await page.locator('.right .panel', { has: page.locator('.panel-toggle:has-text("Curve")') }).locator('.panel-reset').first().click(); await page.waitForTimeout(250);

  // Colour Mixer tabs, Colour Grading
  await openPanel('Color Mixer');
  const mixTabs = await page.locator('[aria-label="Mixer attribute"] button').allInnerTexts();
  check('Color Mixer: Hue | Saturation | Luminance tabs with Red…Magenta', mixTabs.map((t) => t.trim()).join('|') === 'Hue|Saturation|Luminance' && (await page.locator('.mixer-row').count()) === 8);
  await openPanel('Color Grading');
  check('Color Grading: colour wheel with Shadows / Midtones / Highlights / Global, Blending and Balance', (await page.locator('.wheel').count()) === 1 && (await page.locator('[aria-label="Grading range"] button').count()) === 4 && (await page.locator('[data-param=gradeBlending]').count()) === 1 && (await page.locator('[data-param=gradeBalance]').count()) === 1);
  await openPanel('Optics');
  check('Optics: lens profile, Distortion, Vignetting, Chromatic Aberration (Geometry is not here)', (await page.locator('select[aria-label="Lens profile"]').count()) === 1 && (await page.locator('[data-param=lensDistortion]').count()) === 1 && (await page.locator('[data-param=lensVignetting]').count()) === 1 && (await page.locator('[data-param=lensCA]').count()) === 1 && (await page.locator('.right [data-param=geoScale]').count()) === 0);

  // ======================================================================= Crop & Geometry tool
  await importPhoto('tilt.jpg', 'tilt');
  await page.locator('[data-tool=crop]').click(); await page.waitForTimeout(500);
  const aspects = await page.locator('[data-aspect]').allInnerTexts();
  check('Crop aspect list: Original, Custom, Free, 1:1, 4:5, 5:7, 2:3, 3:4, 16:9 (plus 3:2, 4:3)', ['Original', 'Custom', 'Free', '1 : 1', '4 : 5', '5 : 7', '2 : 3', '3 : 4', '16 : 9'].every((l) => aspects.map((a) => a.trim()).includes(l)), aspects.join('|'));
  check('the crop overlay with 8 draggable handles is on the photo, with Done and Cancel', (await page.locator('.crop-overlay [data-handle]').count()) === 8 && (await page.locator('[data-testid=crop-done]').count()) === 1 && (await page.locator('[data-testid=crop-cancel]').count()) === 1);
  await page.locator('[data-aspect="2:3"]').click(); await page.waitForTimeout(300);
  const r23 = (await page.locator('[data-testid=crop-size]').innerText()).match(/(\d+) × (\d+)/);
  check('the 2:3 preset gives a portrait 2:3 crop', !!r23 && Math.abs(+r23[1] / +r23[2] - 2 / 3) < 0.01, await page.locator('[data-testid=crop-size]').innerText());
  check('Lock aspect shows locked', (await page.locator('[data-testid=lock-aspect]').getAttribute('aria-pressed')) === 'true');
  await page.locator('[data-testid=lock-aspect]').click(); await page.waitForTimeout(200);
  check('unlocking makes the aspect Free', (await page.locator('[data-aspect=free].on').count()) === 1 && (await page.locator('[data-testid=lock-aspect]').getAttribute('aria-pressed')) === 'false');
  await page.locator('[data-aspect=free]').click();
  await page.locator('[data-testid=lock-aspect]').click(); await page.waitForTimeout(200);
  check('locking keeps the current proportions', (await page.locator('[data-testid=lock-aspect]').getAttribute('aria-pressed')) === 'true' && (await page.locator('[data-aspect=custom].on').count()) === 1);
  await page.locator('[data-aspect=free]').click();
  check('rotate left/right and flip H/V buttons are in the Crop tab', (await page.locator('.right button:has-text("Left")').count()) >= 1 && (await page.locator('.right button:has-text("Flip H")').count()) === 1 && (await page.locator('.right button:has-text("Flip V")').count()) === 1 && (await page.locator('button:has-text("Orientation")').count()) === 1);
  const linesOf = () => page.locator('.crop-overlay [data-guides] line').count();
  check('overlay guides: rule of thirds by default (4 lines)', (await linesOf()) === 4);
  await page.locator('[data-guides=grid]').click(); check('…Grid draws more lines', (await linesOf()) === 14);
  await page.locator('[data-guides=none]').click(); check('…None draws none', (await page.locator('.crop-overlay [data-guides]').count()) === 0);
  await page.locator('[data-guides=thirds]').click();

  // Straighten tool: draw along the 6-degree horizon
  check('Angle: slider, Auto and a Straighten tool', (await page.locator('[data-param=straighten]').count()) === 1 && (await page.locator('[data-testid=auto-straighten]').count()) === 1 && (await page.locator('[data-testid=straighten-tool]').count()) === 1);
  await page.locator('[data-testid=straighten-tool]').click();
  const cb = await box('[data-testid=viewer-canvas]'), t6 = Math.tan((6 * Math.PI) / 180);
  const pt = (x) => [cb.x + (x / 1200) * cb.width, cb.y + ((400 + (x - 600) * t6) / 800) * cb.height];
  const [ax, ay] = pt(200), [bx, by] = pt(1000);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(400);
  const ang = parseFloat(await page.locator('[data-param=straighten] .slider-number').inputValue());
  check('drawing a line along the horizon sets the Angle to undo its 6° tilt', Math.abs(ang + 6) < 0.6, `angle ${ang}`);
  check('the tool switches itself off afterwards', (await page.locator('[data-testid=straighten-tool]').getAttribute('aria-pressed')) === 'false');
  await page.locator('[data-tool=edit]').click(); await page.waitForTimeout(500);
  const rowDark = async (fx) => page.evaluate(async ([b64, fx]) => { // first row (from top) that is dark at this column = horizon height
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const x = Math.round(bmp.width * fx); const d = g.getImageData(x, 0, 1, bmp.height).data; window.__top = Array.from(d.slice(0, 8)).join(',') + ' size ' + bmp.width + 'x' + bmp.height; for (let y = 4; y < bmp.height; y++) if (d[y * 4 + 3] > 200 && d[y * 4] + d[y * 4 + 1] + d[y * 4 + 2] < 250) return y / bmp.height; return -1;
  }, [(await canvasPng()).toString('base64'), fx]);
  await page.screenshot({ path: 'scripts/.out/dbg-horizon.png' });
  const yl = await rowDark(0.1), yr = await rowDark(0.9);
  check('the horizon is level in the result (same height at both ends)', yl > 0 && Math.abs(yl - yr) < 0.012, `left ${yl.toFixed(3)} right ${yr.toFixed(3)} ${await page.evaluate(() => window.__top)}`);

  // Cancel rewinds, Done keeps
  await page.locator('[data-tool=crop]').click(); await page.waitForTimeout(300);
  const angBefore = await page.locator('[data-param=straighten] .slider-number').inputValue();
  await page.locator('[data-aspect="16:9"]').click(); await setSlider('straighten', 10); await page.waitForTimeout(200);
  await page.locator('[data-testid=crop-cancel]').click(); await page.waitForTimeout(400);
  await page.locator('[data-tool=crop]').click(); await page.waitForTimeout(300);
  check('Cancel rewinds everything done since the tool was opened (aspect and angle)', (await page.locator('[data-aspect=free].on').count()) === 1 && (await page.locator('[data-param=straighten] .slider-number').inputValue()) === angBefore, `angle ${await page.locator('[data-param=straighten] .slider-number').inputValue()} vs ${angBefore}`);
  await page.locator('[data-aspect="1:1"]').click(); await page.locator('[data-testid=crop-done]').click(); await page.waitForTimeout(400);
  await page.locator('[data-tool=crop]').click(); await page.waitForTimeout(300);
  check('Done keeps the changes', (await page.locator('[data-aspect="1:1"].on').count()) === 1);

  // Geometry tab
  await page.locator('[data-crop-tab=geometry]').click(); await page.waitForTimeout(300);
  const up = await page.locator('[data-upright]').evaluateAll((e) => e.map((x) => `${x.getAttribute('data-upright')}${x.disabled ? '(off)' : ''}`));
  check('Geometry tab: Upright Off, Auto, Level, Vertical, Full, Guided (Guided is shown but unavailable)', up.join() === 'off,auto,level,vertical,full,guided(off)', up.join());
  const gk = await page.locator('.right [data-param]').evaluateAll((e) => e.map((x) => x.getAttribute('data-param')));
  check('Transform: Vertical, Horizontal, Rotate, Aspect, Scale, X Offset, Y Offset', gk.join() === 'geoVertical,geoHorizontal,geoRotate,geoAspect,geoScale,geoOffsetX,geoOffsetY', gk.join());
  check('Constrain Crop checkbox, on by default', (await page.locator('[data-testid=constrain-crop]').isChecked()));
  check('the Geometry tab shows the result (no crop rectangle)', (await page.locator('.crop-overlay').count()) === 0);
  await page.locator('[data-crop-tab=crop]').click(); await page.locator('button.tool', { hasText: 'Reset crop' }).click(); await page.locator('[data-crop-tab=geometry]').click(); await page.waitForTimeout(300);
  await setSlider('geoVertical', 40); await page.waitForTimeout(300);
  await page.locator('[data-crop-tab=crop]').click(); await page.waitForTimeout(300);
  const sizeOn = await page.locator('[data-testid=crop-size]').innerText();
  check('with Constrain Crop ON a perspective change shrinks the crop', !/^1200 × 800/.test(sizeOn), sizeOn);
  await page.locator('button.tool', { hasText: 'Reset crop' }).click(); await page.locator('[data-crop-tab=geometry]').click();
  await setSlider('geoVertical', 0); await page.locator('[data-testid=constrain-crop]').uncheck();
  await setSlider('geoVertical', 40); await page.waitForTimeout(300);
  await page.locator('[data-crop-tab=crop]').click(); await page.waitForTimeout(300);
  check('with Constrain Crop OFF the crop is left alone', /^1200 × 800/.test(await page.locator('[data-testid=crop-size]').innerText()), await page.locator('[data-testid=crop-size]').innerText());
  await page.locator('[data-crop-tab=geometry]').click(); await page.locator('[data-testid=constrain-crop]').check(); await setSlider('geoVertical', 0);
  await page.locator('[data-testid=crop-done]').click(); await page.waitForTimeout(300);

  // ======================================================================= Masking tool
  await page.locator('[data-tool=mask]').click(); await page.waitForTimeout(300);
  await page.locator('[data-testid=create-mask]').click();
  const create = await page.locator('[data-create]').evaluateAll((e) => e.map((x) => `${x.getAttribute('data-create')}${x.disabled ? '(off)' : ''}`));
  check('Masking > Create: Subject, Sky, Background, Objects, Brush, Linear, Radial, Color Range, Luminance Range, Depth Range (AI/depth ones shown but unavailable)', ['subject(off)', 'sky(off)', 'background(off)', 'objects(off)', 'brush', 'linear', 'radial', 'color', 'luminance', 'depth(off)'].every((c) => create.includes(c)), create.join());
  await page.locator('[data-create=radial]').click(); await page.waitForTimeout(400);
  await page.locator('.right .panel-toggle', { hasText: /^\s*[▸▾]?\s*Detail\s*$/ }).click(); await page.waitForTimeout(150);
  const groups = await page.locator('.right .panel-toggle').allInnerTexts().then((a) => a.map((t) => t.replace(/[▸▾]/g, '').trim()));
  check('per-mask adjustments appear after a mask is selected: Light, Color, Effects, Detail', ['Light', 'Color', 'Effects', 'Detail'].every((g) => groups.includes(g)), groups.join('|'));
  const lk = await page.locator('.right [data-local]').evaluateAll((e) => e.map((x) => x.getAttribute('data-local')));
  check('…with Exposure…Blacks, Temperature, Tint, Saturation, Texture, Clarity, Dehaze, Sharpness, Noise', ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'saturation', 'texture', 'clarity', 'dehaze', 'sharpness', 'noise'].every((k) => lk.includes(k)), lk.join());
  await page.locator('[data-testid=menu-subtract]').click();
  const subItems = await page.locator('[data-add^="subtract:"]').count();
  await page.keyboard.press('Escape');
  await page.locator('[data-mask].selected [aria-label="Mask options"]').click();
  const opts = await page.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  check('mask list: thumbnail, visibility toggle, Add / Subtract / Intersect menus, Invert in the ⋯ menu, an overlay switch', (await page.locator('.mask-row .mask-thumb').count()) === 1 && (await page.locator('.mask-row [aria-label="Hide mask"]').count()) === 1 && subItems === 5 && (await page.locator('[data-testid=menu-add]').count()) === 1 && (await page.locator('[data-testid=menu-intersect]').count()) === 1 && opts.join('|').includes('Invert mask') && opts.join('|').includes('Delete mask') && (await page.getByLabel('Show overlay').count()) === 1, opts.join('|'));
  check('the Global Edit panels are not in the Masking tool', !groups.includes('Basic') && !groups.includes('Curve'));
  // a mask with Noise really denoises only inside it (radial mask in the centre of the noisy photo)
  await page.locator('[data-tool=edit]').click(); await page.waitForTimeout(200);
  await page.locator('[data-tool=mask]').click(); await page.waitForTimeout(200);
  await page.locator('[data-tool=edit]').click();

  // ======================================================================= Snapshots, toolbar buttons
  await page.locator('[data-photo]').first().click(); await page.waitForTimeout(800); await blur();
  await page.locator('[data-testid=reset-all]').click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300);
  await setSlider('exposure', 0.8);
  await page.locator('input[aria-label="Snapshot name"]').fill('Bright look'); await page.locator('[data-testid=add-snapshot]').click(); await page.waitForTimeout(300);
  check('Snapshots: saving a snapshot lists it in the left panel', (await page.locator('[data-snapshot="Bright look"]').count()) === 1);
  await setSlider('exposure', -1); await setSlider('contrast', 30);
  await page.locator('[data-snapshot="Bright look"] .album-name').click(); await page.waitForTimeout(300);
  check('clicking a snapshot restores every setting (one undoable step)', (await page.locator('[data-param=exposure] .slider-number').inputValue()) === '+0.80' && (await page.locator('[data-param=contrast] .slider-number').inputValue()) === '0' && (await page.locator('.history-list li').first().innerText()) === 'Snapshot: Bright look');
  await page.waitForTimeout(700); await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(900);
  check('snapshots survive a reload', (await page.locator('[data-snapshot="Bright look"]').count()) === 1);
  await page.locator('button[aria-label="Delete snapshot Bright look"]').click(); await page.waitForTimeout(200);
  check('a snapshot can be deleted', (await page.locator('[data-snapshot]').count()) === 0);

  await page.locator('[data-testid=reset-all]').click(); await page.waitForTimeout(300);
  await page.locator('[data-testid=bw-btn]').click(); await page.waitForTimeout(400);
  const bwc = await stats(0.3, 0.1, 0.7, 0.4);
  check('toolbar B&W converts to black & white', bwc.chromaStd < 1.5, `chroma std ${bwc.chromaStd.toFixed(2)}`);
  await page.locator('[data-testid=reset-all]').click(); await page.waitForTimeout(300);
  check('toolbar Reset undoes everything (Reset is disabled again)', await page.locator('[data-testid=reset-all]').isDisabled());
  await page.locator('[data-testid=auto-tone]').click(); await page.waitForTimeout(400);
  check('toolbar Auto applies Auto Tone', (await page.locator('.history-list li').first().innerText()) === 'Auto Tone');
  await page.locator('[data-testid=copy-btn]').click(); check('toolbar Copy opens the copy-settings dialog', (await page.locator('[role=dialog][aria-label="Copy settings"]').count()) === 1);
  await page.locator('[data-testid=copy-confirm]').click(); await page.waitForTimeout(200);
  check('toolbar Paste is enabled once something is copied', !(await page.locator('[data-testid=paste-btn]').isDisabled()));
  await page.locator('[data-zoom-btn=fill]').click(); await page.waitForTimeout(500);
  check('toolbar Fill zooms so the photo covers the window', (await page.locator('[data-testid=viewer-canvas]').getAttribute('data-zoom')) !== 'fit');
  await page.locator('[data-zoom-btn=fit]').click();


  // ======================================================================= Mask overlay behaviour + compact Masks panel
  await page.locator('.filmstrip [data-photo]').nth(1).click(); await page.waitForTimeout(900); await blur();
  await page.locator('[data-testid=reset-all]').click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300);
  await page.locator('[data-tool=mask]').click(); await page.waitForTimeout(300);
  const px = async (fx, fy) => page.evaluate(async ([b64, fx, fy]) => { const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return Array.from(g.getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * fy), 1, 1).data).slice(0, 3); }, [(await canvasPng()).toString('base64'), fx, fy]);
  const reddish = (p) => p[0] - p[2] > -60; // the sky is blue (R-B = -118); the red overlay pushes it up
  await page.locator('[data-testid=create-mask]').click(); await page.locator('[data-create=radial]').click(); await page.waitForTimeout(500);
  check('a new mask does NOT tint the picture red (overlay is off until you ask)', !reddish(await px(0.5, 0.3)) && !(await page.getByLabel('Show overlay').isChecked()));
  await page.locator('label.switch').click(); await page.waitForTimeout(400);
  check('the Show Overlay switch shows the mask in red', reddish(await px(0.5, 0.3)));
  const slider = page.locator('[data-local=exposure] .slider-range'); await slider.scrollIntoViewIfNeeded(); const sb = await slider.boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height / 2); await page.mouse.down(); await page.waitForTimeout(300);
  check('the red overlay disappears while a slider is being dragged', !reddish(await px(0.5, 0.3)));
  await page.mouse.move(sb.x + sb.width * 0.6, sb.y + sb.height / 2, { steps: 4 }); await page.waitForTimeout(200);
  check('…and stays away for the whole drag', !reddish(await px(0.5, 0.3)));
  await page.mouse.up(); await page.waitForTimeout(400);
  const red = (p) => p[0] - p[2];
  const rOn = red(await px(0.5, 0.3)); // released: the switch is still on, so the overlay should be back
  await page.keyboard.press('o'); await page.waitForTimeout(400);
  const rOff = red(await px(0.5, 0.3));
  check('…then comes back when you let go (the switch is still on)', rOn > rOff + 30, `redness ${rOn} vs overlay off ${rOff}`);
  check('the O key toggles the overlay off', !(await page.getByLabel('Show overlay').isChecked()));
  const hdl = await box('[data-handle=center]'); await page.mouse.move(hdl.x + hdl.width / 2, hdl.y + hdl.height / 2); await page.mouse.down(); await page.waitForTimeout(300);
  const rHeld = red(await px(0.5, 0.3));
  check('dragging a mask handle shows the overlay while you hold it, even with the switch off', rHeld > rOff + 30, `held ${rHeld} vs ${rOff}`);
  await page.mouse.up(); await page.waitForTimeout(400);
  check('…and hides it again on release', red(await px(0.5, 0.3)) < rHeld - 30, `${red(await px(0.5, 0.3))}`);

  const thumbData = () => page.locator('.mask-row.selected .mask-thumb').evaluate((c) => { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let mn = 255, mx = 0, s = 0; for (let i = 0; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); s += d[i]; } return { mn, mx, s, w: c.width, h: c.height }; });
  const t0 = await thumbData();
  check('the mask list shows a real thumbnail of the mask (bright where it applies, dark elsewhere)', t0.mx > 200 && t0.mn < 20 && t0.w >= 40, JSON.stringify(t0));
  check('the selected mask lists its shape, with Add and Subtract buttons (no grid of shape buttons)', (await page.locator('.mask-row.selected .comp-row').count()) === 1 && (await page.locator('[data-testid=menu-add]').count()) === 1 && (await page.locator('[data-testid=menu-subtract]').count()) === 1 && (await page.locator('.right button:has-text("Luminance")').count()) === 0);
  await page.locator('[data-testid=menu-subtract]').click(); await page.locator('[data-add="subtract:linear"]').click(); await page.waitForTimeout(500);
  const t1 = await thumbData();
  check('subtracting a shape adds a row and the thumbnail updates', (await page.locator('.mask-row.selected .comp-row').count()) === 2 && t1.s < t0.s, `${t0.s} -> ${t1.s}`);
  await page.locator('.mask-row.selected .mask-name').dblclick(); await page.locator('input[aria-label="Mask name"]').fill('Sky glow'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  check('double-click renames a mask', (await page.locator('.mask-row.selected .mask-name').innerText()) === 'Sky glow');
  await page.locator('[data-mask].selected [aria-label="Mask options"]').click(); await page.getByRole('menuitem', { name: 'Delete mask' }).click(); await page.waitForTimeout(300);
  check('a mask can be deleted from its ⋯ menu', (await page.locator('.mask-list li').count()) === 0);
  await page.locator('[data-tool=edit]').click();

  // ======================================================================= Presets tool
  await page.locator('[data-tool=presets]').click(); await page.waitForTimeout(800);
  check('Presets is a tool in the strip (first icon) and shows Presets | Yours tabs', (await page.locator('[data-tool=presets].on').count()) === 1 && (await page.locator('[data-preset-tab]').count()) === 2 && (await histVisible()));
  const groupsP = await page.locator('[data-preset-group]').evaluateAll((e) => e.map((x) => x.getAttribute('data-preset-group')));
  check('built-in presets are grouped (Color, Black & White, Film & Mood, Detail)', groupsP.join('|') === 'Color|Black & White|Film & Mood|Detail', groupsP.join('|'));
  check('every preset has a preview thumbnail', (await page.locator('.preset-card canvas').count()) === 18);
  const cardStats = () => page.locator('.preset-card canvas').evaluateAll((cs) => cs.map((c) => { if (!c.width) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return [r / n, g / n, b / n]; }));
  await page.waitForTimeout(1500);
  const cs = await cardStats();
  check('previews are actually rendered (none blank)', cs.every((c) => c && c[0] + c[1] + c[2] > 30), `${cs.filter((c) => !c).length} blank`);
  const names = await page.locator('[data-preset]').evaluateAll((e) => e.map((x) => x.getAttribute('data-preset')));
  const ni = names.indexOf('Neutral'), vi = names.indexOf('Vivid');
  check('…and show each preset applied to YOUR photo (Neutral is grey, Vivid is more colourful than Neutral)', Math.max(...cs[ni]) - Math.min(...cs[ni]) < 6 && Math.max(...cs[vi]) - Math.min(...cs[vi]) > Math.max(...cs[ni]) - Math.min(...cs[ni]) + 15, `neutral ${cs[ni].map(Math.round)} vivid ${cs[vi].map(Math.round)}`);
  const hBefore = await page.locator('.history-list li').count();
  await page.locator('[data-preset="Vivid"] .preset-card').click(); await page.waitForTimeout(500);
  check('clicking a preview applies the preset as ONE history step', (await page.locator('.history-list li').count()) === hBefore + 1 && (await page.locator('.history-list li').first().innerText()) === 'Preset: Vivid');
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);

  await page.locator('[data-preset-tab=yours]').click(); await page.waitForTimeout(300);
  check('Yours starts empty, with hints', (await page.locator('[data-testid=no-favorites]').count()) === 1 && (await page.locator('[data-testid=no-mine]').count()) === 1);
  await page.locator('[data-preset-tab=presets]').click();
  await page.locator('[data-preset="Vivid"]').hover(); await page.locator('[data-preset="Vivid"] .preset-fav').click();
  await page.locator('[data-preset="Matte"]').hover(); await page.locator('[data-preset="Matte"] .preset-fav').click();
  check('the star favourites a preset (and stays lit)', (await page.locator('[data-preset="Vivid"]').getAttribute('data-favorite')) === '1');
  await page.locator('[data-preset-tab=yours]').click(); await page.waitForTimeout(300);
  const favNames = await page.locator('[data-preset-group="Favorites"] [data-preset]').evaluateAll((e) => e.map((x) => x.getAttribute('data-preset')));
  check('Yours > Favorites lists the starred presets', favNames.sort().join('|') === 'Matte|Vivid', favNames.join('|'));
  await page.locator('[data-testid=save-preset-btn]').click(); await page.locator('input[aria-label="Preset name"]').fill('My warm look'); await page.locator('[data-testid=preset-save]').click(); await page.waitForTimeout(800);
  const mineNames = await page.locator('[data-preset-group="My presets"] [data-preset]').evaluateAll((e) => e.map((x) => x.getAttribute('data-preset')));
  check('presets you make appear under Yours > My presets, with a preview', mineNames.join() === 'My warm look' && (await page.locator('[data-preset-group="My presets"] canvas').count()) === 1, mineNames.join());
  await page.locator('[data-preset="My warm look"]').hover(); await page.locator('[data-preset="My warm look"] .preset-fav').click();
  await page.waitForTimeout(500); await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(900);
  await page.locator('[data-tool=presets]').click(); await page.locator('[data-preset-tab=yours]').click(); await page.waitForTimeout(600);
  const favAfter = await page.locator('[data-preset-group="Favorites"] [data-preset]').evaluateAll((e) => e.map((x) => x.getAttribute('data-preset')));
  check('favourites and your presets survive a reload', favAfter.sort().join('|') === 'Matte|My warm look|Vivid' && (await page.locator('[data-preset-group="My presets"] [data-preset]').count()) === 1, favAfter.join('|'));
  await page.locator('[data-preset-group="Favorites"] [data-preset="Matte"]').hover(); await page.locator('[data-preset-group="Favorites"] [data-preset="Matte"] .preset-fav').click(); await page.waitForTimeout(300);
  check('un-starring removes it from Favorites', (await page.locator('[data-preset-group="Favorites"] [data-preset="Matte"]').count()) === 0);
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-preset-group="My presets"] [data-preset="My warm look"]').hover(); await page.locator('[data-preset="My warm look"] .preset-del').first().click(); await page.waitForTimeout(400);
  check('a preset of yours can be deleted', (await page.locator('[data-preset="My warm look"]').count()) === 0);
  await page.locator('[data-tool=edit]').click();

  // ======================================================================= Library view
  await page.locator('[data-mode=library]').click(); await page.waitForTimeout(400);
  check('Library view: a photo grid, filters/albums/search on the left, Import in the toolbar', (await page.locator('.photo-grid [data-photo]').count()) === 2 && (await page.locator('input[aria-label="Search photos"]').count()) === 1 && (await page.locator('[data-testid=import-btn]').count()) === 1 && (await page.locator('[data-min-rating]').count()) === 5 && (await page.locator('input[aria-label="New album name"]').count()) === 1);
  check('the Edit tool strip and Edit panels are not shown in Library', (await page.locator('nav.tool-strip').count()) === 0 && (await page.locator('.image-toolbar').count()) === 0);
  await page.locator('.photo-grid [data-photo]').nth(1).dblclick(); await page.waitForTimeout(900);
  check('double-clicking a photo opens it in Edit', (await page.locator('[data-mode=edit].on').count()) === 1 && (await page.locator('[data-testid=file-name]').innerText()).startsWith('tilt'));

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
