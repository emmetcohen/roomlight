// End-to-end checks for Phases 5-7 (retouch, library, presets, export, zoom) in headless Chromium.
import { createServer } from 'vite';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

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
  const makePhoto = (seed, darken = 0, exif = null) => page.evaluate(async ([seed, darken, exif]) => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1200, 800);
    grad.addColorStop(0, `hsl(${200 + seed * 40}, 45%, 62%)`); grad.addColorStop(1, `hsl(${30 + seed * 40}, 50%, 55%)`);
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = '#101010'; g.beginPath(); g.arc(600, 400, 16, 0, Math.PI * 2); g.fill(); // the blemish
    g.fillStyle = `hsl(${seed * 70}, 70%, 40%)`; g.fillRect(120, 560, 160, 120);
    if (darken) { g.fillStyle = `rgba(0,0,0,${darken})`; g.fillRect(0, 0, 1200, 800); }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    let buf = new Uint8Array(await blob.arrayBuffer());
    if (exif) { // a real EXIF block, written by the app's own writer
      const { buildExifSegment } = await import('/src/metadata/exifWriter.ts'); const { injectExif } = await import('/src/metadata/exif.ts');
      buf = injectExif(buf, buildExifSegment(exif, { includeGps: true }));
    }
    let s = ''; buf.forEach((v) => (s += String.fromCharCode(v)));
    return btoa(s);
  }, [seed, darken, exif]);
  const importPhoto = async (name, seed, darken = 0, exif = null) => {
    const jpg = Buffer.from(await makePhoto(seed, darken, exif), 'base64');
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

  // ====================================================================== PHASE 6: library, presets, copy/paste
  const EXIF = { make: 'ACME', model: 'Model One', lens: '35mm F1.8', focalLength: 35, fNumber: 1.8, exposureTime: 1 / 250, iso: 400, capturedAt: new Date(2025, 5, 14, 9, 30, 15).getTime(), copyright: '(c) Tester', gps: { lat: 48.8584, lon: -2.2945 } };
  await importPhoto('beach-01.jpg', 1, 0, EXIF);
  await importPhoto('city-02.jpg', 2);
  await importPhoto('dark-03.jpg', 3, 0.7);
  check('three photos in the filmstrip', (await page.locator('.thumb').count()) === 4);

  // Info + EXIF
  await page.locator('[data-mode=library]').click(); await page.waitForTimeout(300); // photo info lives in the Library view
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(600);
  const exifText = await page.locator('[data-testid=exif-list]').innerText();
  check('EXIF is read from the file and shown (camera, lens, exposure, location)', /ACME Model One/.test(exifText) && /35mm F1\.8/.test(exifText) && /1\/250 s/.test(exifText) && /f\/1\.8/.test(exifText) && /ISO 400/.test(exifText) && /48\.85840/.test(exifText), exifText.replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('[data-photo]').nth(2).click(); await page.waitForTimeout(600);
  check('a file without EXIF says so instead of inventing data', (await page.locator('[data-testid=no-exif]').count()) === 1);

  // Ratings / flags via the keyboard
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(500); await blur();
  await page.keyboard.press('3');
  check('pressing 3 rates the open photo 3 stars', (await page.locator('[data-photo]').nth(1).getAttribute('data-rating')) === '3');
  await page.keyboard.press('3');
  check('pressing 3 again clears the rating', (await page.locator('[data-photo]').nth(1).getAttribute('data-rating')) === '0');
  await page.keyboard.press('4'); await page.keyboard.press('p');
  check('P picks the photo', (await page.locator('[data-photo]').nth(1).getAttribute('data-flag')) === 'pick');
  await page.locator('[data-photo]').nth(2).click(); await page.waitForTimeout(400); await blur();
  await page.keyboard.press('x'); await page.keyboard.press('2');
  check('X rejects a photo', (await page.locator('[data-photo]').nth(2).getAttribute('data-flag')) === 'reject');

  // Filters
  await page.locator('[data-min-rating="4"]').click();
  check('rating filter shows only photos rated ≥ 4', (await page.locator('[data-photo]').count()) === 1 && /1 of 4/.test(await page.locator('[data-testid=photo-count]').innerText()));
  await page.getByRole('button', { name: 'Clear filter' }).first().click();
  await page.locator('[data-flag-filter=reject]').click();
  check('flag filter shows only rejected photos', (await page.locator('[data-photo]').count()) === 1 && (await page.locator('[data-photo]').first().getAttribute('data-flag')) === 'reject');
  await page.locator('[data-flag-filter=reject]').click();
  await page.locator('input[aria-label="Search photos"]').fill('acme');
  check('search finds photos by camera make from EXIF', (await page.locator('[data-photo]').count()) === 1);
  await page.locator('input[aria-label="Search photos"]').fill('city');
  check('search finds photos by file name', (await page.locator('[data-photo]').count()) === 1);
  await page.locator('input[aria-label="Search photos"]').fill('zzz');
  check('a search with no matches says so', (await page.getByText('No photos match this filter.').count()) === 1);
  await page.locator('input[aria-label="Search photos"]').fill('');

  // Metadata editing (keywords are searchable)
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(400);
  await page.locator('input[aria-label=Keywords]').fill('harbour, Sunset, harbour'); await page.locator('input[aria-label=Keywords]').press('Enter');
  await page.locator('input[aria-label=Title]').fill('Evening at the harbour'); await page.locator('input[aria-label=Title]').press('Enter');
  check('keywords are de-duplicated', (await page.locator('input[aria-label=Keywords]').inputValue()) === 'harbour, Sunset');
  await page.locator('input[aria-label="Search photos"]').fill('sunset harbour');
  check('keywords and title are searchable', (await page.locator('[data-photo]').count()) === 1);
  await page.locator('input[aria-label="Search photos"]').fill('');

  // Albums
  await page.locator('input[aria-label="New album name"]').fill('Keepers'); await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(300);
  check('creating an album adds the open photo to it', (await page.locator('[data-album] .album-name').first().innerText()).includes('1'));
  await page.locator('[data-album] .album-name').first().click();
  check('selecting an album shows only its photos', (await page.locator('[data-photo]').count()) === 1);
  await page.locator('.album-list li').first().locator('button').first().click();
  check('All photos shows everything again', (await page.locator('[data-photo]').count()) === 4);

  // Presets (the first tool in the strip)
  await page.locator('[data-mode=edit]').click(); await page.waitForTimeout(400);
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(700);
  const beforePreset = await pixelAt(0.17, 0.78);
  await page.locator('[data-tool=presets]').click(); await page.waitForTimeout(300);
  await page.locator('[data-preset="Neutral"] .preset-card').click(); await page.waitForTimeout(400);
  const bw = await pixelAt(0.17, 0.78);
  check('the Black & White preset removes colour from the picture', Math.abs(bw[0] - bw[1]) < 4 && Math.abs(bw[1] - bw[2]) < 4 && (Math.max(...beforePreset) - Math.min(...beforePreset) > 40), `${beforePreset} -> ${bw}`);
  check('a preset is ONE history entry', (await page.locator('.history-list li').first().innerText()).startsWith('Preset: Neutral'));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const undone = await pixelAt(0.17, 0.78);
  check('undo reverts the preset', Math.abs(undone[0] - beforePreset[0]) < 3);

  // Auto tone on the dark photo
  await page.locator('[data-tool=edit]').click();
  await page.locator('[data-photo]').nth(3).click(); await page.waitForTimeout(700);
  await page.locator('[data-testid=auto-tone]').click(); await page.waitForTimeout(400);
  const exp = parseFloat(await page.locator('[data-param=exposure] .slider-number').inputValue());
  check('Auto tone brightens the dark photo', exp > 0.5, `exposure ${exp}`);
  check('Auto tone is a normal, undoable edit', (await page.locator('.history-list li').first().innerText()).startsWith('Auto Tone'));

  // Save a user preset, apply it to two selected photos at once
  await page.locator('[data-param=vignetteAmount]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-photo]').nth(3).click();
  await page.locator('[data-tool=presets]').click(); await page.locator('[data-testid=save-preset-btn]').click();
  await page.locator('input[aria-label="Preset name"]').fill('My Dark Fix');
  await page.locator('[data-testid=preset-save]').click(); await page.waitForTimeout(300);
  await page.locator('[data-preset-tab=yours]').click();
  check('user preset appears under Yours', (await page.locator('[data-preset="My Dark Fix"]').count()) === 1);
  await page.locator('[data-tool=edit]').click();
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(500);
  await page.locator('[data-photo]').nth(2).click({ modifiers: ['Control'] }); await page.waitForTimeout(200);
  check('Ctrl-click builds a multi-selection', /2 selected/.test(await page.locator('[data-testid=selection-count]').innerText()));
  await page.locator('[data-tool=presets]').click(); await page.locator('[data-preset-tab=yours]').click();
  await page.locator('[data-preset="My Dark Fix"] .preset-card').first().click(); await page.waitForTimeout(800);
  await page.locator('[data-tool=edit]').click();
  check('a preset applies to every selected photo', (await page.locator('.t-edited').count()) >= 3, `${await page.locator('.t-edited').count()} edited`);

  // Copy / paste settings
  await page.locator('[data-photo]').nth(0).click(); await page.waitForTimeout(600); await blur();
  await page.locator('[data-param=exposure] .slider-number').fill('-1.25'); await page.locator('[data-param=exposure] .slider-number').press('Enter');
  await page.locator('[data-param=contrast] .slider-number').fill('33'); await page.locator('[data-param=contrast] .slider-number').press('Enter'); await blur();
  await page.keyboard.press('Control+Shift+C');
  check('Ctrl+Shift+C opens the copy dialog with crop/masks off by default', (await page.locator('[role=dialog] [data-group=tone]').isChecked()) && !(await page.locator('[role=dialog] [data-group=crop]').isChecked()));
  await page.locator('[role=dialog] [data-group=presence]').uncheck();
  await page.locator('[data-testid=copy-confirm]').click();
  await page.locator('[data-photo]').nth(2).click(); await page.waitForTimeout(600); await blur();
  await page.keyboard.press('Control+Shift+V');
  await page.locator('[role=dialog] [data-group=tone]').waitFor();
  check('the paste dialog lists only what was copied', (await page.locator('[role=dialog] [data-group]').count()) >= 5 && (await page.locator('[role=dialog] [data-group=presence]').count()) === 0);
  await page.locator('[data-testid=paste-confirm]').click(); await page.waitForTimeout(600);
  check('paste sets the copied exposure and contrast', (await page.locator('[data-param=exposure] .slider-number').inputValue()) === '-1.25' && (await page.locator('[data-param=contrast] .slider-number').inputValue()) === '+33');
  check('paste is one undoable history entry', (await page.locator('.history-list li').first().innerText()) === 'Paste Settings');

  // Persistence across a reload
  await page.waitForTimeout(800);
  await page.reload(); await page.waitForSelector('.thumb.current'); await page.waitForTimeout(1000);
  await page.locator('[data-mode=library]').click(); await page.waitForTimeout(300);
  check('ratings, flags and albums survive a reload', (await page.locator('[data-photo]').nth(1).getAttribute('data-rating')) === '4' && (await page.locator('[data-photo]').nth(1).getAttribute('data-flag')) === 'pick' && (await page.locator('[data-album]').count()) === 1);
  await page.locator('[data-mode=edit]').click(); await page.waitForTimeout(300);
  await page.locator('[data-tool=presets]').click(); await page.locator('[data-preset-tab=yours]').click(); await page.waitForTimeout(300);
  check('the saved preset is still listed', (await page.locator('[data-preset="My Dark Fix"]').count()) === 1);
  await page.screenshot({ path: 'scripts/.out/library.png' });

  // ====================================================================== PHASE 7: export
  const exif = await server.ssrLoadModule('/src/metadata/exif.ts');
  /** Width/height from a JPEG's SOF marker. */
  const jpegSize = (b) => { let i = 2; while (i < b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1]; const len = (b[i + 2] << 8) | b[i + 3]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }; i += 2 + len; } return null; };
  const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  const dim = (o) => (o ? `${o.w}x${o.h}` : 'none');
  const openExport = async () => { await blur(); await page.keyboard.press('Control+Shift+E'); await page.locator('[role=dialog][aria-label=Export]').waitFor(); };
  const doExport = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('[data-testid=export-go]').click()]);
    const path = `scripts/.out/${dl.suggestedFilename()}`; await dl.saveAs(path);
    await page.locator('[data-testid=export-done]').waitFor({ timeout: 60000 });
    return { name: dl.suggestedFilename(), bytes: readFileSync(path), path };
  };
  const selectFormat = (v) => page.locator('select[aria-label=Format]').selectOption(v);
  const closeExport = async () => { await page.locator('.dialog-foot button', { hasText: 'Close' }).click(); await page.waitForTimeout(150); };
  /** Decode exported bytes in the page and sample a pixel (in export pixel coordinates). */
  const decodedPixel = (bytes, mime, x, y) => page.evaluate(async ([b64, mime, x, y]) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u], { type: mime }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
  }, [bytes.toString('base64'), mime, x, y]);

  // --- a single JPEG at full size, EXIF kept, location removed (the defaults)
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(700); await blur();
  await page.locator('[data-testid=reset-all]').click(); await page.waitForTimeout(400); // clean baseline after the Phase 6 edits
  await openExport();
  check('export dialog shows the output size', /1200 × 800 px/.test(await page.locator('[data-testid=export-size]').innerText()));
  check('it warns that this photo carries location data', (await page.locator('.gps-flag').count()) === 1);
  let r = await doExport();
  check('file is named from the template', r.name === 'beach-01-edit.jpg', r.name);
  check('it is a real JPEG at the full native size', r.bytes[0] === 0xff && r.bytes[1] === 0xd8 && dim(jpegSize(r.bytes)) === '1200x800', JSON.stringify(jpegSize(r.bytes)));
  let ex = exif.parseExif(new Uint8Array(r.bytes));
  check('EXIF is carried over (camera, lens, exposure) with Orientation reset to 1', ex && ex.model === 'Model One' && ex.lens === '35mm F1.8' && ex.iso === 400 && ex.orientation === 1, JSON.stringify(ex));
  check('location was removed from the exported file', ex && ex.gps === undefined);
  check('the export ran in a background worker', /background worker/.test(await page.locator('[data-testid=export-where]').innerText()), await page.locator('[data-testid=export-where]').innerText());

  // --- keep the location
  await page.locator('label:has-text("Remove location") input').uncheck();
  r = await doExport(); ex = exif.parseExif(new Uint8Array(r.bytes));
  check('with "Remove location" off the GPS position is kept', ex?.gps && Math.abs(ex.gps.lat - 48.8584) < 1e-3);
  await page.locator('label:has-text("Remove location") input').check();

  // --- copyright notice rewrites the EXIF block
  await page.locator('input[aria-label="Copyright notice"]').click(); await page.keyboard.type('(c) 2026 Test Photographer');
  check('typing in a dialog field keeps the focus (no focus stealing on re-render)', (await page.locator('input[aria-label="Copyright notice"]').inputValue()) === '(c) 2026 Test Photographer');
  r = await doExport(); ex = exif.parseExif(new Uint8Array(r.bytes));
  check('a copyright notice is written into the EXIF', ex?.copyright === '(c) 2026 Test Photographer' && ex.model === 'Model One' && ex.gps === undefined, JSON.stringify(ex));
  await page.locator('input[aria-label="Copyright notice"]').fill('');

  // --- metadata off
  await page.locator('select[aria-label=Metadata]').selectOption('none');
  r = await doExport();
  check('metadata "None" strips all EXIF', exif.parseExif(new Uint8Array(r.bytes)) === null);
  await page.locator('select[aria-label=Metadata]').selectOption('original');

  // --- resize + formats
  await page.locator('select[aria-label=Resize]').selectOption('longEdge');
  await page.locator('input[aria-label="Long edge in pixels"]').click(); await page.keyboard.type('600'); await page.keyboard.press('Enter');
  check('typing a size digit by digit works (no clamping mid-typing)', (await page.locator('input[aria-label="Long edge in pixels"]').inputValue()) === '600');
  check('the dialog previews the resized output', /600 × 400 px/.test(await page.locator('[data-testid=export-size]').innerText()));
  r = await doExport();
  check('long-edge resize gives 600 × 400', dim(jpegSize(r.bytes)) === '600x400', JSON.stringify(jpegSize(r.bytes)));
  await selectFormat('png');
  r = await doExport();
  check('PNG export is a real PNG of the right size', r.name.endsWith('.png') && r.bytes.subarray(1, 4).toString() === 'PNG' && dim(pngSize(r.bytes)) === '600x400');
  check('metadata is disabled for PNG with an explanation', (await page.locator('select[aria-label=Metadata]').isDisabled()) && (await page.getByText('Metadata can only be embedded in JPEG files.').count()) === 1);
  await selectFormat('webp');
  r = await doExport();
  check('WebP export is a real WebP', r.name.endsWith('.webp') && r.bytes.subarray(0, 4).toString() === 'RIFF' && r.bytes.subarray(8, 12).toString() === 'WEBP');
  await selectFormat('jpeg');
  await page.locator('select[aria-label=Resize]').selectOption('original');

  // --- edits are baked in: Black & White preset -> exported pixels have no colour
  await closeExport();
  const colorBlock = async (b) => decodedPixel(b, 'image/jpeg', 200, 620);
  await openExport(); r = await doExport(); const plain = await colorBlock(r.bytes); await closeExport();
  await page.locator('[data-testid=bw-btn]').click(); await page.waitForTimeout(500);
  await openExport(); r = await doExport(); const mono = await colorBlock(r.bytes); await closeExport();
  check('edits are applied to the exported pixels (B&W preset removes colour)', Math.max(...plain) - Math.min(...plain) > 40 && Math.max(...mono) - Math.min(...mono) < 6, `${plain} -> ${mono}`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);

  // --- output sharpening: an unsharp mask (luma only) leaves an overshoot "halo" next to a luminance edge (the dark dot's left edge, x = 584)
  const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const ring = async (bytes) => Math.abs(luma(await decodedPixel(bytes, 'image/jpeg', 583, 400)) - luma(await decodedPixel(bytes, 'image/jpeg', 570, 400)));
  await openExport();
  r = await doExport(); const ringOff = await ring(r.bytes);
  await page.locator('select[aria-label="Output sharpening"]').selectOption('high');
  r = await doExport(); const ringHigh = await ring(r.bytes);
  check('high output sharpening adds an overshoot halo at edges; off leaves the gradient smooth', ringOff < 4 && ringHigh > ringOff + 8, `halo ${ringOff.toFixed(1)} -> ${ringHigh.toFixed(1)}`);
  await page.locator('select[aria-label="Output sharpening"]').selectOption('off');
  await closeExport();

  // --- retouching is included in exports (full-res, from the original file)
  await page.locator('[data-photo]').nth(0).click(); await page.waitForTimeout(700); await blur();
  check('the blemish photo is open (spot-free)', dark(await pixelAt(0.5, 0.5)));
  await page.keyboard.press('q'); await page.locator('[data-spot-kind=remove]').click(); await page.locator('[data-retouch=size] .slider-number').fill('40'); await page.locator('[data-retouch=size] .slider-number').press('Enter'); await blur();
  await clickAt(0.5, 0.5); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await openExport(); r = await doExport(); await closeExport();
  const dot = await decodedPixel(r.bytes, 'image/jpeg', 600, 400);
  check('the exported file has the blemish removed', dot[0] + dot[1] + dot[2] > 250, `${dot}`);
  const origBytes = readFileSync('scripts/.out/retouch.png'); void origBytes;

  // --- a photo larger than the on-screen preview exports at its TRUE size
  await importPhoto('big-04.jpg', 4); // 1200x800 placeholder to keep the page helper simple; replaced below
  const bigB64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3600; c.height = 2400; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 3600, 2400); gr.addColorStop(0, '#2a6fb0'); gr.addColorStop(1, '#e8b050'); g.fillStyle = gr; g.fillRect(0, 0, 3600, 2400);
    g.fillStyle = '#000'; for (let i = 0; i < 40; i++) g.fillRect(100 + i * 80, 1200, 2, 600); // 2px lines: only visible at full resolution
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95)); const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; u.forEach((v) => (s += String.fromCharCode(v))); return btoa(s);
  });
  await page.setInputFiles('input[type=file]', { name: 'huge-05.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bigB64, 'base64') });
  await page.waitForFunction(() => document.querySelector('.file-name')?.textContent?.startsWith('huge-05')); await page.waitForTimeout(900); await blur();
  await openExport();
  check('the dialog reports the true full size (3600 × 2400), not the preview size', /3600 × 2400 px/.test(await page.locator('[data-testid=export-size]').innerText()));
  r = await doExport(); await closeExport();
  check('a 3600 × 2400 original exports at 3600 × 2400 (full resolution)', dim(jpegSize(r.bytes)) === '3600x2400', JSON.stringify(jpegSize(r.bytes)));
  const line = await decodedPixel(r.bytes, 'image/jpeg', 101, 1500), gap = await decodedPixel(r.bytes, 'image/jpeg', 140, 1500);
  check('fine detail survives at full resolution (a 2-px line is still dark)', line[0] + line[1] + line[2] < 200 && gap[0] + gap[1] + gap[2] > 300, `${line} vs ${gap}`);


  // --- zoom, pan and full resolution (the 3600 x 2400 photo, whose preview is only 2560 px wide)
  await page.locator('[data-photo]').last().click(); await page.waitForTimeout(900); await blur();
  const cv = page.locator('[data-testid=viewer-canvas]');
  const attr = (n) => cv.getAttribute(n);
  check('the viewer starts fitted, on the preview', (await attr('data-zoom')) === 'fit' && /^preview 2560x1707/.test(await attr('data-source')), `${await attr('data-zoom')} ${await attr('data-source')}`);
  const fitCentre = await pixelAt(0.5, 0.5);
  await page.locator('[data-zoom-btn="100"]').click();
  await page.waitForFunction(() => /^full 3600x2400/.test(document.querySelector('[data-testid=viewer-canvas]')?.getAttribute('data-source') ?? ''), null, { timeout: 30000 });
  await page.waitForTimeout(600);
  check('100% zooms to exactly one image pixel per screen pixel', Math.abs(parseFloat(await attr('data-zoom')) - 1) < 0.001 && (await page.locator('[data-testid=zoom-readout]').innerText()) === '100%', `${await attr('data-zoom')}`);
  check('above the preview resolution the original is loaded at its true 3600 × 2400', /full 3600x2400/.test(await attr('data-source')));
  const zoomCentre = await pixelAt(0.5, 0.5);
  check('the zoomed picture shows the same scene (colour at the centre agrees with the fitted view)', Math.hypot(zoomCentre[0] - fitCentre[0], zoomCentre[1] - fitCentre[1], zoomCentre[2] - fitCentre[2]) < 25, `${fitCentre} vs ${zoomCentre}`);
  // fine detail: the 2-px black lines every 80 px are resolved at 100 %
  const darkRuns = async () => {
    const png = await cv.screenshot();
    return page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const y = Math.round(bmp.height * 0.8); const row = g.getImageData(0, y, bmp.width, 1).data; const runs = []; let len = 0;
      for (let x = 0; x < bmp.width; x++) { const d = row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2] < 200; if (d) len++; else { if (len) runs.push(len); len = 0; } }
      return runs;
    }, png.toString('base64'));
  };
  const runs = await darkRuns();
  check('1:1 detail is real: the 2-px lines are resolved as narrow dark runs', runs.length >= 8 && runs.every((l) => l <= 4) && runs.filter((l) => l >= 2).length >= 6, `${runs.length} runs: ${runs.slice(0, 10)}`);

  // pan by dragging
  const v0 = (await attr('data-view')).split(',').map(Number);
  const b = await canvasBox();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.5 - 200, b.y + b.height * 0.5 - 100, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300);
  const v1 = (await attr('data-view')).split(',').map(Number);
  check('dragging pans the window (200 px left = 200/3600 of the width)', Math.abs((v1[0] - v0[0]) - 200 / 3600) < 0.004 && Math.abs((v1[1] - v0[1]) - 100 / 2400) < 0.004, `${v0} -> ${v1}`);
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5); await page.mouse.down(); await page.mouse.move(b.x - 5000, b.y - 5000, { steps: 4 }); await page.mouse.up();
  const v2 = (await attr('data-view')).split(',').map(Number);
  check('the window stops at the picture edge instead of going past it', v2[0] + v2[2] <= 1.0001 && v2[1] + v2[3] <= 1.0001 && v2[0] >= 0, `${v2}`);

  // wheel zoom about the cursor
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4);
  const z0 = parseFloat(await attr('data-zoom'));
  await page.mouse.wheel(0, -400); await page.waitForTimeout(400);
  check('the mouse wheel zooms in', parseFloat(await attr('data-zoom')) > z0 * 1.2, `${z0} -> ${await attr('data-zoom')}`);
  await page.mouse.wheel(0, 4000); await page.waitForTimeout(500);
  check('zooming all the way out returns to Fit', (await attr('data-zoom')) === 'fit');
  check('leaving zoom releases the full-resolution copy', /^preview/.test(await attr('data-source')));

  // Z key and buttons
  await page.keyboard.press('z'); await page.waitForTimeout(400);
  check('Z toggles to 100 %', Math.abs(parseFloat(await attr('data-zoom')) - 1) < 0.001);
  await page.keyboard.press('z'); await page.waitForTimeout(300);
  check('Z toggles back to Fit', (await attr('data-zoom')) === 'fit');
  await page.locator('[data-zoom-btn="200"]').click(); await page.waitForTimeout(500);
  check('the 200% button zooms to 2.0', Math.abs(parseFloat(await attr('data-zoom')) - 2) < 0.001);

  // neighbourhood effects while zoomed (whole-picture blur source, windowed draw) — must render, and change the picture
  await page.locator('[data-param=clarity] .slider-number').fill('70'); await page.locator('[data-param=clarity] .slider-number').press('Enter'); await page.waitForTimeout(500);
  await page.locator('[data-param=dehaze] .slider-number').fill('40'); await page.locator('[data-param=dehaze] .slider-number').press('Enter'); await page.waitForTimeout(500);
  const withLocal = await pixelAt(0.3, 0.3);
  await page.locator('[data-testid=reset-all]').click(); await page.waitForTimeout(500);
  const noLocal = await pixelAt(0.3, 0.3);
  check('clarity + dehaze render in a zoomed window and change the picture', Math.hypot(withLocal[0] - noLocal[0], withLocal[1] - noLocal[1], withLocal[2] - noLocal[2]) > 4, `${noLocal} -> ${withLocal}`);
  await page.locator('[data-zoom-btn="fit"]').click(); await page.waitForTimeout(300);

  // tools keep working while zoomed: retouch click lands where the pointer is
  await page.locator('[data-photo]').first().click(); await page.waitForTimeout(900); await blur();
  await page.locator('[data-testid=reset-all]').click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300);
  await page.locator('[data-zoom-btn="200"]').click(); await page.waitForTimeout(600);
  check('the blemish is still there, now at twice the size', dark(await pixelAt(0.5, 0.5)));
  await page.keyboard.press('q'); await page.locator('[data-spot-kind=remove]').click(); await page.locator('[data-retouch=size] .slider-number').fill('40'); await page.locator('[data-retouch=size] .slider-number').press('Enter'); await blur();
  await clickAt(0.5, 0.5);
  const spotC = await page.evaluate(() => { const c = document.querySelector('[data-spot] circle[data-handle=target]'); const r = c.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width / 2]; });
  const bb = await canvasBox();
  check('the spot marker is drawn where it was placed, at the zoomed scale', Math.abs(spotC[0] - (bb.x + bb.width / 2)) < 6 && Math.abs(spotC[1] - (bb.y + bb.height / 2)) < 6 && spotC[2] > 40, `${spotC}`);
  await page.locator('label.chk:has-text("Show spots") input').uncheck(); await blur(); await page.waitForTimeout(400);
  check('retouching works in a zoomed window', !dark(await pixelAt(0.5, 0.5)), JSON.stringify(await pixelAt(0.5, 0.5)));
  await page.locator('label.chk:has-text("Show spots") input').check();
  await page.keyboard.press('Escape'); await page.locator('[data-zoom-btn="fit"]').click();

  // --- batch export as one ZIP, validated by Python's zipfile
  await blur(); await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+E'); await page.locator('[role=dialog][aria-label=Export]').waitFor();
  await page.locator('select[aria-label=Resize]').selectOption('longEdge'); await page.locator('input[aria-label="Long edge in pixels"]').fill('400'); await page.keyboard.press('Enter');
  const nPhotos = await page.locator('[data-photo]').count();
  check('"Selected" is offered and pre-chosen for a multi-selection', (await page.locator('button:has-text("Selected (")').getAttribute('class'))?.includes('on'));
  r = await doExport();
  check('a batch is bundled into one ZIP', r.name.endsWith('.zip'), r.name);
  const py = spawnSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("|".join(sorted(z.namelist())))`, r.path], { encoding: 'utf8' });
  const names = py.stdout.trim().split('|');
  check(`Python's zipfile reads the archive (${nPhotos} unique files, CRCs valid)`, py.status === 0 && names.length === nPhotos && new Set(names).size === nPhotos, `${py.stderr.trim()} ${names.join(', ')}`);
  const zipped = spawnSync('python3', ['-c', `import zipfile,sys,io; z=zipfile.ZipFile(sys.argv[1]); n=[x for x in z.namelist() if x.startswith("beach")][0]; open(sys.argv[2],"wb").write(z.read(n))`, r.path, 'scripts/.out/from-zip.jpg']);
  const fz = readFileSync('scripts/.out/from-zip.jpg');
  check('a file taken out of the ZIP is a valid 400 × 267 JPEG with EXIF', zipped.status === 0 && dim(jpegSize(fz)) === '400x267' && exif.parseExif(new Uint8Array(fz))?.model === 'Model One', JSON.stringify(jpegSize(fz)));
  await closeExport();
  await page.screenshot({ path: 'scripts/.out/export.png' });

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
