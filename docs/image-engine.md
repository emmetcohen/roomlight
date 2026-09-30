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
(`lens, whiteBalance, exposure, tone, local, curve, mixer, grading, color, masks, vignette, grain`),
preceded by the **source sampler** (crop · rotate · perspective · lens distortion · chromatic aberration). Each stage has

* a CPU implementation (`model.ts`) — the reference/spec, used by tests and as a fallback, and
* a GLSL function (`glsl.ts`) — used for real-time rendering.

`buildFragmentShader(order)` assembles the shader in the given order, so reordering or
inserting stages (curves, colour mixer, masks, detail…) means editing data, not the renderer.
`npm run verify:gpu` renders a test image through the real WebGL2 shader in headless Chromium and
checks it against the CPU reference (currently ≤ 1 8-bit level difference on all cases).

**Multi-pass:** all stages are per-pixel except `local` (texture / clarity / dehaze), which needs blurred
neighbourhoods. When `local` is active the renderer runs: pass 1 (stages before `local`) → RGBA16F target →
three blur fields (box-downsample → Gaussian H → Gaussian V, at a power-of-two reduced resolution so the
widest blur stays ≤ ~40 taps) → pass 2 (`local` + later stages). When it is inactive the whole pipeline is one
pass. All other stages are compiled once and switched on/off by uniform flags, so moving a slider never
recompiles a shader. `derive.ts` computes every derived value (gains, LUT, blur plan, flags) once; the CPU
reference and GPU uniforms both read it, so they cannot disagree about what a slider means.

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

## Adjustments (Phase 2)

### Tone curve (`curves`: four point lists `rgb`, `r`, `g`, `b`)
* **Input/Output:** linear RGB → **encoded** sRGB [0,1] → curve → decode. Curves are display-referred (like the
  histogram they are drawn over); values are clamped to [0,1] before the curve. **Nonlinear.** No masks.
* **Interpolation:** monotone cubic Hermite (PCHIP / Fritsch–Carlson): C¹-smooth, passes through every point,
  and cannot overshoot between monotone points. Outside the first/last point the curve is flat, so moving the
  first point right is an input **black point** and moving the last point left is an input **white point**;
  moving them up/down lifts blacks / lowers whites.
* **Channels:** `out_c = curve_c(curve_rgb(x))`, composed on the CPU into one 1024×RGB lookup table (RGBA16F
  texture, linear filtered). Cost on the GPU: three texture reads per pixel. A default curve skips the stage.
* **Editing:** `addPoint / movePoint / removePoint` (pure, tested) keep points sorted with a minimum gap; the
  end points cannot be removed.

### Colour mixer (`mix_<color>_<hue|sat|lum>`, 24 sliders, −100…100)
* **Space:** OKLab/OKLCH (perceptually uniform hue/chroma). **Nonlinear.** Hue centres are the OKLCH hues of pure
  red/orange/yellow/green/aqua/blue/purple/magenta (29°, 53°, 110°, 143°, 195°, 264°, 294°, 328°).
* **Smooth bands:** for a pixel of hue h only the two neighbouring bands are non-zero, cross-faded with a
  smoothstep, so weights sum to 1 (partition of unity) and there is no boundary. A pixel between red and orange
  is moved partly by both sliders.
* **Model:** `h' = h + 30°·Σw·hue`, `C' = C·(1 + Σw·sat)`, `L' = L + 0.25·Σw·lum`, all scaled by a chroma gate
  `smoothstep(0, 0.03, C)` so neutral pixels (undefined hue) are untouched. Out-of-gamut results clamp at 0.

### Colour grading (`grade_<shadows|mid|highlights|global>_<hue|sat|lum>`, `gradeBlending`, `gradeBalance`)
* **Space:** OKLab. A tint is a vector added to (a, b): `chroma = sat/100·0.08` at hue angle `h`; luminance adds
  `lum/100·0.2` to L. The wheel UI draws the same OKLCH colours, so the marker sits on the colour that is added.
* **Range weights** on encoded luminance v: `shadows = 1 − smoothstep(0.3+s−w, 0.3+s+w, v)`,
  `highlights = smoothstep(0.7+s−w, 0.7+s+w, v)`, `mid = 1 − shadows − highlights` (≥ 0), global = 1.
  **Balance** shifts both crossovers (`s = −0.25·balance/100`: + favours highlights); **Blending** sets the
  transition half-width `w = 0.04 + 0.26·blending/100`.

### Texture, Clarity, Dehaze (`texture`, `clarity`, `dehaze`, −100…100) — neighbourhood stage
* **Fields** (radii are fractions of the long edge L): `σ_texture = 0.0012·L`, `σ_clarity = 0.010·L`,
  `σ_dehaze = 0.030·L` (minimum 0.6 / 1.5 / 3 px). Texture and clarity blur the perceptual luminance
  `v = sRGB_OETF(Y)`; dehaze blurs the dark channel `min(r,g,b)`.
* **Texture / Clarity:** add scaled detail, `v' = v + 0.9·tex·(v − blur_σt(v)) + 0.8·clar·m(v)·d/(1+3|d|)`,
  with `d = v − blur_σc(v)` and `m(v) = 4v(1−v)` (mid-tone emphasis). The `d/(1+3|d|)` term soft-limits strong
  edges to reduce halos. Colour is preserved by luminance-ratio scaling (see Tone stage).
* **Dehaze +:** simplified dark-channel prior, `J = (I − A)/t + A`, `A = 1`, `t = max(1 − 0.9·dehaze·darkBlur, 0.15)`.
  **Dehaze −:** blends toward a 0.7 grey haze (up to 60%), which lifts blacks and lowers contrast.
* **Approximations:** a Gaussian base layer halos at strong edges (no edge-aware/guided filter yet); dehaze uses a
  blurred dark channel and a fixed airlight instead of a refined transmission map. Both are isolated in
  `adjustments.ts` / `local` and can be upgraded without touching parameters.
* **Performance:** blurs run only while one of the three sliders is non-zero, at reduced resolution.

### Vignette (`vignetteAmount/Midpoint/Roundness/Feather/Highlights`)
* **Space:** linear light, like exposure. **Model:** `gain = 2^(amount·k·2.5)` where
  `k = smoothstep(midpoint, midpoint + feather', d)` and `d` is the normalised distance from the centre
  (0 centre, 1 corner). **Roundness** ≥ 0 bends the shape to a true circle in image space; < 0 raises the
  superellipse exponent (2 → 6) toward a rounded rectangle. **Highlights** (for darkening only) blends the gain
  back toward 1 on bright pixels: `gain' = gain + (1 − gain)·hl·smoothstep(0.4, 0.9, v)`.
* Applied to the whole frame for now; once cropping exists it will follow the crop (post-crop vignette).

### Grain (`grainAmount/Size/Roughness`)
* **Procedural:** a 32-bit integer hash (identical on CPU and GPU), no texture. `soft` = bilinearly interpolated
  lattice noise with cell size from **Size** (`(0.0007 + 0.004·size/100)·L` px, ≥ 1); `fine` = per-pixel noise;
  **Roughness** cross-fades soft → fine. Both are scaled to σ ≈ 0.577 (uniform white-noise σ).
* Added in encoded space as `Δ = noise·0.12·amount/100·(0.25 + 0.75·4v(1−v))` (strongest in mid-tones), the same
  value on all channels (monochrome grain). Zero-mean, deterministic (no flicker between renders).
* Because cell size scales with the output size, grain looks alike on preview and export at the same aspect, but
  is not pixel-identical across resolutions.

## Geometry, crop and lens (Phase 3)

All of this is *inverse mapping*: for every output pixel the renderer computes which position in the
**original** to read, then does one bilinear read (in linear light). There are no intermediate resampled
images, nothing is baked in, and the original is never modified. `src/geometry/transform.ts` is the spec.

### Transform matrix (Geometry panel + Straighten + orientation)
* **Coordinates:** source pixels, origin at the centre, +y down (positive angles are clockwise on screen).
  The *canvas* is the source after orientation; the crop rectangle is normalised in canvas space.
* **Forward model (source → canvas):** `M = T · Rs · S · A · P · Rg · O`, applied right to left:
  `O` flips then k×90° turns · `Rg` Rotate (±10°) · `P` perspective · `A` aspect squeeze · `S` scale · `Rs` Straighten (±45°) · `T` offset.
* **Perspective `P`** is a homography with third row `(h/Rn, v/Rn, 1)`, `h = Horizontal·0.35/100`,
  `v = Vertical·0.35/100`, `Rn` = half the canvas diagonal, so the effect is independent of resolution.
  `x' = x/w, y' = y/w, w = 1 + (h·x + v·y)/Rn`. + Vertical widens the top and narrows the bottom (corrects looking up at a building).
* **Aspect** scales x by `2^(0.4·a)` and y by the inverse (area preserving). **Offset** ±100 = ±half the canvas.
* **Rendering:** `p_canvas = ((crop.xy + uv·crop.wh) − ½)·canvasSize`, `p_src = project(M⁻¹, p_canvas)`. Where `p_src`
  falls outside the original the pixel is transparent (never smeared). `M` is inverted in JS (3×3) and uploaded as a `mat3`.
* **Space / linearity:** geometry is resampling in linear light; projective (nonlinear in position). No masks involved.
* **Performance:** one extra 3×3 multiply per pixel; free when the geometry is the identity (fast path).

### Crop (`crop` rectangle + aspect preset) and orientation
* The crop is four normalised numbers (+ preset). Changing it never touches pixels; the Crop tool draws the *whole* rotated
  canvas with the rectangle on top, so the original is always available to re-crop. The rendered output size follows the crop.
* Presets: Free, Original, 1:1, 4:5, 3:2, 4:3, 16:9, Custom w:h, with a landscape/portrait swap. A locked ratio is exact for
  corner and edge drags (`dragCrop`). Rotate left/right also turns the crop rectangle; flips act on the original before other adjustments.
* **Keeping the crop valid:** after any geometry edit the crop is shrunk about its centre (bisection, `fitCropInside`) until all four
  corners read from inside the original — so Straighten never shows empty corners. It only ever shrinks; *Reset crop* restores the framing.

### Lens corrections (`lensDistortion`, `lensVignetting`, `lensCA`, `lensProfile`)
* **Radial model**, `rc` = distance from the optical centre / half-diagonal of the source:
  * Distortion: read the source at `rs = rc·(1 − a·rc²)`, `a = distortion/100·0.25` (+ corrects barrel, − corrects pincushion).
  * Chromatic aberration (lateral): red is read at `rs·(1+s)`, blue at `rs·(1−s)`, `s = ca/100·0.004`; green is the reference.
  * Vignetting (a normal pipeline stage, first, in linear light): `gain = 2^(vig/100 · 2 · rc²)`.
* **Profiles** (`src/lens/profiles.ts`): `{distortion, vignetting, chromaticAberration}` in slider units; effective = profile + manual sliders.
  **No measured lens database ships.** The two profiles in the list are labelled *(example)* and are illustrative numbers;
  real profiles are added with `registerLensProfile`.
* **Approximations:** a 2-term-at-most radial polynomial (one coefficient), centred on the frame, purely radial CA. Tangential
  distortion, per-focal-length interpolation and per-channel polynomial CA are future profile fields.

### Upright — automatic perspective (`src/geometry/upright.ts`)
Sobel edges (after a light blur) of a 384px copy → samples (position, direction, weight). Edges within 20° of vertical/horizontal in
the current result are assumed to be lines that should be straight. A coordinate search (coarse scan + golden section) minimises the
weighted angular error of those lines **after applying the real geometry matrix** (truncated-quadratic loss ignores outliers; a
small penalty prefers gentle corrections). Modes: Level (Straighten), Vertical, Auto (level + vertical), Full (+ horizontal).
If fewer than ~40 suitable edges exist or the error doesn't improve meaningfully, it reports that and changes nothing.

## Masks and local adjustments (Phase 4)

A mask is a greyscale field `m(x,y) ∈ [0,1]`: 0 = adjustment doesn't apply, 1 = fully, in between = partially.
Model: `Mask { name, enabled, invert, amount, components[], adjust{} }`. **Mask space** is centred source pixels divided by the long
edge, so masks are attached to the picture: they follow it through crop, rotate, straighten and perspective (tested).

### Components and combining
`linear`, `radial`, `brush`, `color` (range), `luminance` (range), `segment` (AI, see below). Each component has `op`
(`add | subtract | intersect`) and `invert`. Fuzzy-set rules, starting from 0 (or from 1 if the first component is not *add*):
add `m = max(m, c)` · subtract `m = min(m, 1−c)` · intersect `m = min(m, c)`. Then the mask's invert (`1−m`) and amount (`·amount/100`).

| component | value | parameters |
|---|---|---|
| Linear gradient | `t = ((p−a)·(b−a))/|b−a|²`, `m = 1 − smoothstep(½−f/2, ½+f/2, t)` | start a (full), end b (none), feather f (0–100, rotation = angle of a→b) |
| Radial gradient | `d = |R(−θ)(p−c) / (rx,ry)|`, `m = 1 − smoothstep(1−f, 1, d)` | centre, rx, ry, rotation θ, feather f, invert |
| Colour range | `d = √((½ΔL)² + Δa² + Δb²)` in OKLab vs the target, `m = 1 − smoothstep(0.35r, r, d)`, `r = 0.02 + 0.3·range/100` | target (eyedropper on the photo), range |
| Luminance range | `m = smoothstep(lo−s, lo+s, v)·(1 − smoothstep(hi−s, hi+s, v))` on perceptual luminance `v` (ends at 0 / 1 are open) | min, max, smoothness |
| Brush | raster sampled bilinearly (below) | strokes |

**Range masks look at the original colour** (after geometry/lens sampling, before any edit), so adjusting inside a mask never moves it.

### Brush (`src/masks/brush.ts`)
Strokes (points with pen pressure, radius, feather, flow, density, erase) are the stored data: tiny, resolution independent, JSON-persistable
and cheap in undo history. They are rasterised into a 1024² 8-bit field over mask-space [−½, ½]². Dabs are stamped every 20% of the diameter
with falloff `1 − smoothstep(1−feather, 1, r)` and opacity `flow`; dabs accumulate *within* a stroke (`s += (1−s)·a`), so low flow builds up as you
paint; the stroke is capped by `density` and added (`1−(1−m)(1−t)`) or erased (`m·(1−t)`). Pressure scales radius (30–100%) and flow when the
device reports it. Rasters are cached by stroke-list identity and extended incrementally while painting. The GPU holds them in one 2D-array texture.

### Local adjustments
Exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, texture, clarity, dehaze.
* **Basic adjustments** run in a `masks` stage after the global colour stage, in the same order as the global pipeline (WB → exposure → tone → colour),
  using the *same functions* as the global stages with **every amount scaled by the mask value** `m`: exposure = `2^(stops·m)`, tone/colour sliders × m.
  So m = 0 leaves the pixel untouched, m = 1 is identical to applying the adjustment globally (tested), and m = ½ is exactly half the stops for exposure
  and approximately half for the others. Several masks apply one after another.
* **Texture / clarity / dehaze** are added to the global amounts *inside the `local` stage*: `amount = global + Σ mask_i·local_i` (clamped to ±1), using
  the same blur fields — so a mask can sharpen mid-tone contrast or remove haze in one region without any extra blur pass.
* **Performance:** up to 8 masks, 16 components in total and 8 raster layers (uniform budget; the UI explains when a limit is reached). Everything is
  evaluated per pixel in the same shader pass; nothing runs for a mask with no adjustments except the overlay.
* **Overlay:** the masking tool tints the selected mask red, computed by the same shader from the same mask value (what you see is what is applied).

### Subject / Sky / Background (AI selection) — architecture only
`src/masks/segmentation.ts` defines a `SegmentationProvider { available(), segment(image, kind) → 1024² mask }` registry. **No model is bundled**, so the
three buttons are disabled and say so; nothing pretends to detect a subject. A registered provider's raster is used exactly like a brush raster (unit
tested with a clearly-named test double). Rasters from providers are not persisted yet (they would be recomputed).

## Retouching: clone, heal, remove (Phase 5) — `src/retouch/`
A **spot** `{ kind, x, y, sx, sy, r, feather, opacity, enabled }` replaces the pixels inside a circle (centre `x,y`, radius `r`) with pixels from a source circle
(centre `sx,sy`). Coordinates are **mask space** (centred source px ÷ long edge), so spots follow the picture through crop, rotate and perspective, and are
resolution independent (the same list is applied to the 2560 px preview, the full-size 1:1 view and the export). Spots are applied to the **source pixels
before** geometry and every tonal adjustment — a derived cache (`retouchedPixels`), never written back; "Before" shows the genuine original.

* **Clone** — copy the source circle as it is. Blend weight `w(d) = 1` inside `R(1−feather)`, smoothstep down to 0 at `R`; result `= mix(target, source, w·opacity)`.
* **Heal** — seamless-cloning by boundary interpolation. With source offset `d` and `N = 32` points `b_i` on a circle just outside the spot, the mismatch
  `e_i = T(b_i) − S(b_i + d)` is interpolated inside with **mean-value coordinates** (Floater 2003):
  `m(p) = Σ λ_i(p) e_i`, `λ_i ∝ (tan(α_{i−1}/2) + tan(α_i/2)) / |b_i − p|`, `α_i` = angle at `p` between `b_i` and `b_{i+1}`.
  `healed(p) = max(0, S(p + d) + m(p))`. `m` equals the boundary mismatch on the boundary (no seam) and is smooth inside (only low-frequency colour/brightness
  changes), so the copied texture survives. All in linear light.
* **Remove** — heal with an **automatically chosen source**: candidates on rings at `2.3, 3.2, 4.4, 6 ×R` around the target (16 angles each, never overlapping it);
  score = Σ|T(q_j) − S(q_j + d)|² over 32 points on two rings just outside the target + `0.3·32·Var(candidate interior)` (so a patch with its own blemish loses);
  lowest score wins; deterministic. This is classic patch matching, **not generative AI**: it can only reuse what already exists in the photo. If no candidate
  fits inside the picture it reports that and changes nothing.
* Spots apply in list order (later spots see earlier results); the input array is never modified; limits: 64 spots.

## Library, metadata, presets (Phase 6)
* **Storage v2** (`src/storage/db.ts`): additive stores `info` (per-photo rating/flag/label/title/caption/keywords/albums/EXIF — kept *separate* from the photo record so the
  original is never rewritten), `albums`, `presets`. A v1 database upgrades in place (tested).
* **EXIF** (`src/metadata/exif.ts`, `exifWriter.ts`): dependency-free JPEG reader for camera, lens, exposure, date, GPS, copyright; returns `null` — never invented
  values — for files without EXIF. It can also carry the original block into an export (Orientation reset to 1 because pixels are already upright), delete the GPS
  IFD in place, or write a fresh block from the understood fields. Fuzz-tested against corrupted input.
* **Query** (`src/library/query.ts`): filters AND together (rating ≥ n, flags, colour label, album, edited-only, free text over name/title/caption/keywords/camera/lens);
  natural sort by name, capture time (falls back to import time), rating, date added.
* **Presets and copy/paste** are the same object: a *sparse* parameter set (`src/presets/snapshot.ts`) made of **groups** (`groups.ts`: WB, tone, presence, colour, curve,
  mixer, grading, vignette, grain, lens, geometry, crop, masks, spots). Applying one overwrites only the parameters it contains, validates/clamps the result, gives
  masks and spots fresh ids, and is one undo step — also on photos that are not open. Built-in presets are plain data (`builtin.ts`, tested to be in-range and to
  change the picture); user presets are stored and can be exported/imported as JSON (validated on import).
* **Auto tone** (`src/image-engine/autoTone.ts`) is a histogram heuristic, not AI: exposure puts the median at encoded 0.46 (damped ×0.85, ±2.5 EV), blacks/whites/contrast from the
  1 % / 99 % points after that exposure, shadows/highlights recovery from the size of the dark/bright populations. Always clamped; always undoable.

## Export, zoom and performance (Phase 7)
* **Export** (`src/export/`): the original file is decoded at full size (orientation applied), retouched, rendered by the *same* shader pipeline at the **output size**
  (no upscaling of the preview), un-premultiplied, optionally sharpened, flattened over a background colour for JPEG, encoded, and (JPEG) given metadata.
  `renderExport` runs identically in a **module Web Worker** (OffscreenCanvas + WebGL2) or on the main thread; `runExport` picks the worker and falls back to the
  main thread if a worker is unavailable or blocked, and the dialog says which one ran. GPU/pixel limits are reported, never hidden.
  * Resize: full / long edge / fit-in-box / percent, with "don't enlarge". Formats: JPEG, PNG, WebP (if the browser cannot encode WebP it writes PNG and says so).
  * Output sharpening (`sharpen.ts`): unsharp mask on **luminance only** of the final 8-bit pixels: `Y = 0.2126R+0.7152G+0.0722B`, `c' = c + 1.5·(amount/100)·(Y − G_σ*Y)`,
    `σ = clamp(longEdge/3000, 0.6, 1.8)` px. An edge between two colours of equal luminance is therefore (correctly) not sharpened.
  * Batches: file-name templates (`{name} {n} {nnn} {date} {rating} {title} {w} {h}`), unique names, and a store-only **ZIP** writer with CRC-32 (validated against Python's `zipfile`).
  * Colour: exports are sRGB; there is no wide-gamut / ICC output yet.
* **View windows and zoom** (`ViewWindow` in `webglRenderer.ts`, `src/editor/viewMath.ts`): the shader takes `u_view = (x, y, w, h)`, the region of the output picture being drawn, and a
  *virtual* output size (the picture at the current zoom). Every effect is a function of **output position**, so a window shows exactly what a full-size render shows there;
  the parity harness checks a half-size window against the same pixels of the full render (70 cases, difference 0). Texture/Clarity/Dehaze need whole-picture blur fields:
  a zoomed window takes them from a whole-picture render of ≤3072 px (cached until the edit changes), which is exact for exports (no window) and an approximation at very high zoom.
  Above the preview's resolution the original is decoded at full size (capped by the GPU's texture limit) and released again when zoom returns to Fit.

## Import
`src/import/decoders.ts` is a decoder registry. Only the browser decoder (JPEG/PNG/WebP/…) is
installed. RAW, HEIC and TIFF files are **rejected with an explicit message**, never treated as
JPEG. A RAW decoder = implement `ImageDecoder`, `registerDecoder()`.
Images are decoded with EXIF orientation applied. The editing preview is capped at 2560px on the
long edge; the original file stays in storage for full-resolution export and 1:1 viewing.

## Known limitations (Phase 1)
See README.md.
