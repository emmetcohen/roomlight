# Roomlight

A non-destructive, GPU-accelerated photo editor for the browser (React + TypeScript + Vite + WebGL2).
Original design and code — not a clone of any existing product.

```
npm install
npm run dev          # http://localhost:5173
npm test             # engine / history / storage unit tests (vitest)
npm run verify:gpu   # WebGL shaders vs CPU reference (77 cases + 73 zoom windows), in headless Chromium
npm run verify:e2e   # drives the real UI in headless Chromium: Phases 1–4, then 5–7 (inspects exported files), then the layout + Detail suite
npm run verify:build # builds the single-file page and exports a photo through it
npm run build
```
`verify:*` use Playwright with a system Chromium (`CHROMIUM_PATH`, or `/opt/pw-browsers/chromium`).

## Status: Phases 1–7 complete, plus Detail (noise reduction + input sharpening)

Working: import (JPEG/PNG/WebP), filmstrip, viewer, real histogram (+ clipping), undo/redo + history list, reset per slider / section / all,
before/after, IndexedDB persistence (originals + edits + crops + masks), shortcuts, and:

* **Basic:** White Balance (Temp, Tint, auto, eyedropper), Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Texture, Clarity, Dehaze, Vibrance, Saturation
* **Tone Curve** (RGB/R/G/B, black/white points, smooth spline) · **Color Mixer** (8 colours × H/S/L) · **Color Grading** (wheels, blending, balance)
* **Effects:** Vignette and procedural Grain
* **Crop tool:** free / original / 1:1 / 4:5 / 3:2 / 4:3 / 16:9 / custom ratios, rotate 90°, flip, straighten — all non-destructive
* **Geometry:** Vertical, Horizontal, Rotate, Aspect, Scale, X/Y offset via a real homography; **Upright** (auto level / vertical / full) from detected straight edges
* **Lens corrections:** distortion, vignetting, chromatic aberration, plus a lens-profile registry (only clearly-labelled *example* profiles ship)
* **Masking tool:** brush (size, feather, flow, density, erase, pen pressure), linear and radial gradients (handles, feather, rotation), colour range with eyedropper,
  luminance range; add / subtract / intersect / invert; per-mask local adjustments (exposure … dehaze); overlay. Subject / Sky / Background are
  **unavailable** (no segmentation model is installed) and labelled as such; the plug-in interface exists.

* **Retouch tool (Q):** clone, heal (seamless mean-value blend) and remove (heal with an automatically found source — patch matching, *not* generative AI). Spots are parameters, always editable.
* **Library:** 1–5 stars, pick/reject, colour labels, albums, search (name, title, caption, keywords, camera), filters, sorting, multi-select, EXIF viewer, title/caption/keywords. Keyboard: `0–5`, `P`, `X`, `U`, `6–9`.
* **Presets:** 18 built-in (colour, B&W, film & mood, detail) and your own (save, export/import JSON); **copy/paste settings** by group (Ctrl+Shift+C / V), applied to several photos at once; **Auto tone** (histogram heuristic, not AI).
* **Export (Ctrl+Shift+E):** JPEG / PNG / WebP at full resolution from the original file (not the preview), in a background worker; resize modes, output sharpening, EXIF keep / basic / none, GPS removal, copyright,
  file-name templates, batches as one ZIP.
* **Zoom & pan:** Fit / 100 % / 200 %, wheel zoom around the cursor, drag to pan, `Z`; the original is decoded at full size while zoomed in.

* **Detail:** input sharpening (Amount, Radius, Detail, Masking) and noise reduction (Luminance, Detail, Contrast; Color, Detail, Smoothness) on the source pixels, also per mask (Sharpness, Noise). Runs in a worker; included in exports.
* **Parametric curve** next to the point curve; **Snapshots**; White Balance As Shot / Auto / Custom; Crop & Geometry tool with lock, guides, a draw-a-line straighten tool, Cancel and Constrain Crop.

Layout: **Library | Edit** switch on top; tools (Presets, Edit, Crop & Geometry, Healing / Remove, Masking) in a vertical strip on the far right; History and Snapshots on the left; Library view = photo grid.

**Presets tool:** a grid of previews (each preset rendered on your photo), grouped; tap ☆ to favourite; the **Yours** tab holds favourites and the presets you save. **Masking tool:** one *Create New Mask* button (menu of mask types), a list of masks with live thumbnails and their shapes, *Add / Subtract / Intersect* menus, a *Show Overlay* switch (off by default; `O`). The red overlay shows while you hold a mask handle or paint, and hides while you drag a slider.

Not built: Guided Upright, Objects / Depth Range masks, Auto Mask, automatic Remove Chromatic Aberration and Defringe, lens make/model database, "As Shot" crop aspect (same as Original), RAW/HEIC/TIFF decoding, real subject/sky selection (needs a model), lens database, wide-gamut/ICC output, tethering, print/web galleries.

## Deploying
`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub Pages on every push to `main`
(enable once under Settings → Pages → Source: GitHub Actions). `npm run build:single` produces one
self-contained HTML file (`dist-single/roomlight.html`).

## Limitations
* RAW / HEIC / TIFF are refused with a clear message (no decoder installed; the registry is ready for one).
* The fitted preview is rendered at ≤2560px at full quality on every slider move (no low-res-while-dragging mode); zooming in decodes the full-size original.
* Texture/Clarity/Dehaze use a Gaussian base layer (halos at strong edges) and need float render targets
  (EXT_color_buffer_float); without them they are disabled with a notice.
* The crop only ever shrinks automatically (to hide empty edges); use *Reset crop* to get the framing back. Flips act on the original before other adjustments.
* Mask range selections and lens correction use simple models (see docs); masks are limited to 8 masks / 16 components / 8 brush layers per photo.
* Upright needs long straight edges; it says so and does nothing when it can't find them.
* Source data is 8-bit; internal math is float, but the texture starts as 8-bit sRGB.
* Tone-region sliders are global curves, not local (see docs/image-engine.md).
* Auto white balance is grey-world and is poor on single-colour-dominated scenes.
* Requires WebGL2. History is in-memory (edits, not history, persist across reload).
* Export: sRGB only; the ZIP is built in memory (keep batches to a few hundred MB, 4 GB hard limit); metadata is embedded in JPEG only; a batch of many separate downloads may be blocked by the browser (use the ZIP option).
  Outputs are limited by the GPU texture size and 120 MP. If a worker cannot run (blocked context), export runs on the main thread and the UI freezes while it renders.
* Zoomed windows compute Texture/Clarity/Dehaze blur fields from a ≤3072 px whole-picture render (exact in exports).
* Retouch *Remove* only reuses pixels from the same photo; for large objects or missing content it will not look right (no generative fill). Spot markers are circles even under strong perspective.
* Detail is computed on the CPU in a worker (≈1 s per update on a large preview, the picture updates when it finishes); it is not part of the GPU shader.
* Library search is substring based; albums are flat; EXIF is read for JPEG only; no XMP/IPTC sidecars.

See `docs/image-engine.md` for the math of each adjustment.
