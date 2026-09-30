# Roomlight

A non-destructive, GPU-accelerated photo editor for the browser (React + TypeScript + Vite + WebGL2).
Original design and code — not a clone of any existing product.

```
npm install
npm run dev          # http://localhost:5173
npm test             # engine / history / storage unit tests (vitest)
npm run verify:gpu   # WebGL shaders vs CPU reference (74 cases), in headless Chromium
npm run verify:e2e   # drives the real UI in headless Chromium
npm run build
```
`verify:*` use Playwright with a system Chromium (`CHROMIUM_PATH`, or `/opt/pw-browsers/chromium`).

## Status: Phases 1–4 complete

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

Not yet (by phase): heal/clone (5); presets, copy/paste, ratings, flags, albums, search, EXIF metadata (6); export, full-res/worker rendering,
zoom/pan (7). Detail (sharpening / noise reduction) is in the spec but not scheduled in a phase yet.

## Deploying
`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub Pages on every push to `main`
(enable once under Settings → Pages → Source: GitHub Actions). `npm run build:single` produces one
self-contained HTML file (`dist-single/roomlight.html`).

## Limitations
* RAW / HEIC / TIFF are refused with a clear message (no decoder installed; the registry is ready for one).
* The preview is rendered at ≤2560px at full quality on every slider move (low-res-while-dragging is Phase 7).
* Texture/Clarity/Dehaze use a Gaussian base layer (halos at strong edges) and need float render targets
  (EXT_color_buffer_float); without them they are disabled with a notice.
* The crop only ever shrinks automatically (to hide empty edges); use *Reset crop* to get the framing back. Flips act on the original before other adjustments.
* Mask range selections and lens correction use simple models (see docs); masks are limited to 8 masks / 16 components / 8 brush layers per photo.
* Upright needs long straight edges; it says so and does nothing when it can't find them.
* Source data is 8-bit; internal math is float, but the texture starts as 8-bit sRGB.
* Tone-region sliders are global curves, not local (see docs/image-engine.md).
* Auto white balance is grey-world and is poor on single-colour-dominated scenes.
* Requires WebGL2. History is in-memory (edits, not history, persist across reload).
* Fit-to-window only (no zoom/pan yet).

See `docs/image-engine.md` for the math of each adjustment.
