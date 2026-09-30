# Roomlight image engine

## Non-destructive model

```
ORIGINAL (Blob, never modified)  +  EditParams (≈10 numbers)  ──render──▶  pixels
```

* The original file bytes are stored once in IndexedDB (`photos` store) and never rewritten.
* An edit is an `EditParams` object (`src/image-engine/params.ts`). Edits are saved separately
  (`edits` store), as a versioned, clamped-on-load JSON object.
* Undo/redo/history are a list of immutable `EditParams` snapshots (`src/history`). No pixels
  are stored per step.
* Rendering is a pure function of `(original texture, params)`. "Reset" is setting params to
  defaults; the render then equals the original (verified bit-exact by tests).

## Pipeline

`src/image-engine/pipeline.ts` defines the pipeline as an **ordered list of stages**
(`['whiteBalance','exposure','tone','color']`). Each stage has

* a CPU implementation (`model.ts`) — the reference/spec, used by tests and as a fallback, and
* a GLSL function (`glsl.ts`) — used for real-time rendering.

`buildFragmentShader(order)` assembles the shader in the given order, so reordering or
inserting stages (curves, colour mixer, masks, detail…) means editing data, not the renderer.
`npm run verify:gpu` renders a test image through the real WebGL2 shader in headless Chromium and
checks it against the CPU reference (currently ≤ 1 8-bit level difference on all cases).

**Data flow:** 8-bit sRGB decode → GPU `SRGB8_ALPHA8` texture (hardware converts to *linear* on
sampling; mip-mapped downscaling is therefore done in linear light) → one float shader pass
through all stages → clamp → sRGB encode → display. There is no intermediate 8-bit storage between
adjustments. Compression happens only on explicit export (Phase 7).

**Working space:** linear-light RGB with sRGB/Rec.709 primaries, unbounded above 1.0 (exposure
can push values past white; later stages such as Highlights can pull them back).

## Adjustments (Phase 1)

Common notes: *"Masks"* — none yet; masks arrive in Phase 4 and will run the same stage functions
with a per-pixel blend weight. *"Linear"* refers to the operation in linear light.

### White balance — Temp, Tint (`temperature`, `tint`, −100…100)
* **Input/Output:** linear RGB → linear RGB. **Space:** linear. **Operation:** per-channel gain (linear).
* **Model:** with t = temp/100, s = tint/100:
  `raw = (2^(0.4t), 2^(−0.3s), 2^(−0.4t))`, then divided by `luma(raw)` so white keeps its luminance.
  Warm (+) raises red / lowers blue; +tint lowers green (towards magenta).
* **Approximation:** real editors use camera-specific matrices and Kelvin units. Ours is a
  documented relative scale, not Kelvin. Gains are applied in the Rec.709 working space, not a
  cone-response space (no Bradford/CAT02).
* **Eyedropper / Auto:** `solveWhiteBalance` is the exact algebraic inverse of the model: given the
  linear RGB of something that should be neutral it returns (temp, tint) (clamped to ±100). The
  eyedropper averages a 5×5 block of the *unedited* 384px analysis copy. **Auto** is a grey-world
  estimate (mean of non-clipped pixels) — crude on scenes dominated by one colour.
* **Performance:** gains are computed in JS and passed as a `vec3` uniform.

### Exposure (`exposure`, −5…+5 stops)
* **Input/Output:** linear RGB. **Space:** linear. **Linear** operation.
* **Model:** `out = in × 2^stops`. +1 stop doubles linear-light intensity, −1 halves it.
  Not applied to encoded values. Values >1 are kept until the final clamp.
* **Note:** a production editor adds highlight roll-off / tone mapping; here highlight handling is
  left to the Highlights/Whites sliders and the final clamp.

### Tone stage — Contrast, Highlights, Shadows, Whites, Blacks
* **Space:** luminance Y is computed in linear light and converted to a perceptual value
  `v = sRGB_OETF(Y)`; the curve is applied to `v`; the resulting `Y' = sRGB_EOTF(v')`. **Nonlinear.**
* **Applying to colour:** the pixel is scaled by `Y'/Y` (hue-preserving; avoids the saturation
  shifts of per-channel curves). Below `Y = 0.001` the ratio is ill-conditioned, so it cross-fades
  to a neutral grey of luminance `Y'` — this is why Blacks can lift pure black.
* **Contrast (−100…100):** symmetric S-curve about 0.5 with shape `m`
  (`m = c` for c≥0, `m = 0.5c` for c<0; c = slider/100):
  `y = 0.5·x / (1 + m(1−x))`, x = 2v for v ≤ 0.5, mirrored above. Mid slope `1+m`; `m=0` is
  exactly identity; f(0)=0, f(½)=½, f(1)=1; monotonic. Values >1 pass through.
* **Highlights / Shadows / Whites / Blacks (−100…100):** additive displacement of `v`:
  `v' = v_c + Σ gain_r · (slider_r/100) · toneWeight(v_c, r)`, where weights are smoothsteps
  (no hard thresholds; see `toneWeight`, `TONE_EDGES`, `TONE_GAIN` in `model.ts`):

  | region | weight | max shift at ±100 |
  |---|---|---|
  | Shadows | `1 − smoothstep(0.15, 0.65, v)` | 0.18 |
  | Highlights | `smoothstep(0.35, 0.85, v)` | 0.18 |
  | Whites | `smoothstep(0.70, 1.00, v)` | 0.12 |
  | Blacks | `1 − smoothstep(0.00, 0.30, v)` | 0.12 |

  Gains are chosen so the whole tone curve stays monotonic for every combination of extreme
  slider settings (a test enumerates all 3⁵ combinations), i.e. tones never invert.
* **Approximation:** Adobe's Highlights/Shadows are local (they involve blurred luminance); ours are
  global tone curves. A local variant can replace `toneWeight` inputs with a blurred-luminance
  channel without changing the parameters.

### Vibrance & Saturation (−100…100)
* **Space:** linear light, about luminance. **Linear** scaling of chroma.
* **Model:** `chroma = (max−min)/max`; `s = (1 + sat/100)·(1 + vib/100·(1 − chroma))`;
  `out = Y + (in − Y)·s`. −100 saturation is exact greyscale at unchanged luminance.
  Vibrance weights by `1 − chroma`, so muted colours move more than saturated ones.
* **Approximation:** no skin-tone protection; out-of-gamut results are clamped at output.
  Perceptual-space saturation (e.g. OKLab chroma) is a later refinement and, with the Color Mixer,
  will need a hue-aware colour space.

### Histogram
Computed from the **rendered output** (same shader program, drawn into a ≤256px framebuffer and read
back with `readPixels`), not from the source. Shows R/G/B/Luma bins (256) and the share of pixels with
any channel at 255 (red) / 0 (blue). The "clipping" toggle on the image uses the same rule in the shader.

## Import
`src/import/decoders.ts` is a decoder registry. Only the browser decoder (JPEG/PNG/WebP/…) is
installed. RAW, HEIC and TIFF files are **rejected with an explicit message**, never treated as
JPEG. A RAW decoder = implement `ImageDecoder`, `registerDecoder()`.
Images are decoded with EXIF orientation applied. The editing preview is capped at 2560px on the
long edge; the original file stays in storage for full-resolution export.

## Known limitations (Phase 1)
See README.md.
