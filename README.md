# Roomlight

A non-destructive, GPU-accelerated photo editor for the browser (React + TypeScript + Vite + WebGL2).
Original design and code — not a clone of any existing product.

```
npm install
npm run dev          # http://localhost:5173
npm test             # engine / history / storage unit tests (vitest)
npm run verify:gpu   # WebGL shader vs CPU reference, in headless Chromium
npm run verify:e2e   # drives the real UI in headless Chromium
npm run build
```
`verify:*` use Playwright with a system Chromium (`CHROMIUM_PATH`, or `/opt/pw-browsers/chromium`).

## Status: Phase 1 complete

Working: import (JPEG/PNG/WebP, drag-drop or button), filmstrip, viewer, White Balance (Temp, Tint,
auto, eyedropper), Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Vibrance, Saturation,
real histogram (+clipping indicators), undo/redo + history list, reset per slider / section / all,
before/after, IndexedDB persistence of originals and edits, keyboard shortcuts.

Not yet (by phase): tone curve, colour mixer/grading, texture/clarity/dehaze, vignette, grain (2);
crop/geometry/lens (3); masks (4); heal/clone (5); presets, copy/paste, ratings, flags, albums,
search, EXIF metadata (6); export, full-res/worker rendering, zoom/pan (7).

## Limitations
* RAW / HEIC / TIFF are refused with a clear message (no decoder installed; the registry is ready for one).
* The preview is rendered at ≤2560px; it always renders at full preview quality (the low-res-while-dragging
  path is Phase 7). The GPU makes this fast enough for now.
* Source data is 8-bit; internal math is float, but the texture starts as 8-bit sRGB.
* Tone-region sliders are global curves, not local (see docs/image-engine.md).
* Auto white balance is grey-world and is poor on single-colour-dominated scenes.
* Requires WebGL2. History is in-memory (edits, not history, persist across reload).
* Fit-to-window only (no zoom/pan yet).

See `docs/image-engine.md` for the math of each adjustment.
