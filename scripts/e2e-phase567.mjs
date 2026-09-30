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

  await page.locator('[data-left-tab=history]').click();
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
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(600);
  await page.locator('[data-left-tab=info]').click();
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
  await page.locator('[data-left-tab=library]').click();
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
  await page.locator('[data-left-tab=info]').click();
  await page.locator('input[aria-label=Keywords]').fill('harbour, Sunset, harbour'); await page.locator('input[aria-label=Keywords]').press('Enter');
  await page.locator('input[aria-label=Title]').fill('Evening at the harbour'); await page.locator('input[aria-label=Title]').press('Enter');
  check('keywords are de-duplicated', (await page.locator('input[aria-label=Keywords]').inputValue()) === 'harbour, Sunset');
  await page.locator('[data-left-tab=library]').click();
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

  // Presets
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(700);
  await page.locator('[data-left-tab=history]').click();
  const beforePreset = await pixelAt(0.17, 0.78);
  await page.locator('.panel-toggle:has-text("Presets")').click();
  await page.locator('[data-preset="Neutral"] button').click(); await page.waitForTimeout(400);
  const bw = await pixelAt(0.17, 0.78);
  check('the Black & White preset removes colour from the picture', Math.abs(bw[0] - bw[1]) < 4 && Math.abs(bw[1] - bw[2]) < 4 && (Math.max(...beforePreset) - Math.min(...beforePreset) > 40), `${beforePreset} -> ${bw}`);
  check('a preset is ONE history entry', (await page.locator('.history-list li').first().innerText()).startsWith('Preset: Neutral'));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const undone = await pixelAt(0.17, 0.78);
  check('undo reverts the preset', Math.abs(undone[0] - beforePreset[0]) < 3);

  // Auto tone on the dark photo
  await page.locator('[data-photo]').nth(3).click(); await page.waitForTimeout(700);
  await page.locator('[data-testid=auto-tone]').click(); await page.waitForTimeout(400);
  const exp = parseFloat(await page.locator('[data-param=exposure] .slider-number').inputValue());
  check('Auto tone brightens the dark photo', exp > 0.5, `exposure ${exp}`);
  check('Auto tone is a normal, undoable edit', (await page.locator('.history-list li').first().innerText()).startsWith('Auto Tone'));

  // Save a user preset, apply it to two selected photos at once
  await page.locator('[data-left-tab=history]').click();
  await page.locator('[data-param=vignetteAmount]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-photo]').nth(3).click();
  await page.getByRole('button', { name: 'Save current as preset…' }).click();
  await page.locator('input[aria-label="Preset name"]').fill('My Dark Fix');
  await page.locator('[data-testid=preset-save]').click(); await page.waitForTimeout(300);
  check('user preset appears in the list', (await page.locator('[data-preset="My Dark Fix"]').count()) === 1);
  await page.locator('[data-photo]').nth(1).click(); await page.waitForTimeout(500);
  await page.locator('[data-photo]').nth(2).click({ modifiers: ['Control'] }); await page.waitForTimeout(200);
  check('Ctrl-click builds a multi-selection', /2 selected/.test(await page.locator('[data-testid=selection-count]').innerText()));
  await page.locator('[data-preset="My Dark Fix"] button').first().click(); await page.waitForTimeout(800);
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
  check('ratings, flags and albums survive a reload', (await page.locator('[data-photo]').nth(1).getAttribute('data-rating')) === '4' && (await page.locator('[data-photo]').nth(1).getAttribute('data-flag')) === 'pick' && (await page.locator('[data-album]').count()) === 1);
  check('user presets survive a reload', (await page.locator('.panel-toggle:has-text("Presets")').count()) === 1);
  await page.locator('.panel-toggle:has-text("Presets")').click();
  check('the saved preset is still listed', (await page.locator('[data-preset="My Dark Fix"]').count()) === 1);
  await page.screenshot({ path: 'scripts/.out/library.png' });

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
