/**
 * GLSL ES 3.00 implementation of the pipeline, generated from the stage order. Formulas and
 * constants mirror model.ts / adjustments.ts (constants are interpolated from there).
 *
 * The source texture is SRGB8_ALPHA8, so sampling returns linear light (and mip-mapping
 * filters in linear space). Intermediate targets are RGBA16F.
 */
import { LUMA } from '../color/colorSpace';
import {
  CLARITY_GAIN, CLARITY_SOFTNESS, DEHAZE_AIRLIGHT, DEHAZE_MIN_T, DEHAZE_OMEGA, HAZE_ADD_LEVEL, HAZE_ADD_MAX,
  MIX_CHROMA_GATE, MIX_HUES, MIX_HUE_SHIFT_DEG, MIX_LUM_GAIN, TEXTURE_GAIN, VIGNETTE_STOPS,
} from './adjustments';
import { LUT_SIZE } from './curves';
import type { Derived, StageId } from './derive';
import { RATIO_FLOOR, TONE_EDGES, TONE_GAIN } from './model';

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

export const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Textures are uploaded top-row-first (no UNPACK_FLIP_Y, which ImageBitmap ignores),
  // so flip V here: clip-space +y (top of screen) samples the first image row.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const COMMON = `
const vec3 LUMA = vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])});
uniform vec2 u_size;
vec2 g_px;   // output pixel (x, y from the bottom), like the CPU reference
vec2 g_size;
float srgbToLinear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float linearToSrgb(float x) {
  x = max(x, 0.0);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
vec3 linearToSrgb3(vec3 c) { return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b)); }
vec3 srgbToLinear3(vec3 c) { return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)); }
float cbrt1(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 linearToOklab(vec3 c) {
  float l = cbrt1(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrt1(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrt1(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
vec3 oklabToLinear(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z;
  float l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return vec3(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
              -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
              -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3);
}
vec3 scaleToLuma(vec3 c, float y, float y2) {
  float w = clamp(y / ${f(RATIO_FLOOR)}, 0.0, 1.0);
  float k = y2 / max(y, 1e-6);
  return vec3(y2) + (c * k - vec3(y2)) * w;
}
`;

const STAGE_GLSL: Record<StageId, string> = {
  whiteBalance: `
uniform vec3 u_wb;
vec3 stage_whiteBalance(vec3 c) { return c * u_wb; }`,

  exposure: `
uniform float u_expGain;
vec3 stage_exposure(vec3 c) { return c * u_expGain; }`,

  tone: `
uniform float u_contrastShape;
uniform vec4 u_tone; // shadows, highlights, whites, blacks, each in [-1, 1]
float contrastCurve(float v, float m) {
  if (v >= 1.0) return v;
  if (v <= 0.0) return 0.0;
  if (v <= 0.5) { float x = 2.0 * v; return 0.5 * x / (1.0 + m * (1.0 - x)); }
  float x = 2.0 - 2.0 * v;
  return 1.0 - 0.5 * x / (1.0 + m * (1.0 - x));
}
float toneCurve(float v) {
  float vc = contrastCurve(v, u_contrastShape);
  float vv = clamp(vc, 0.0, 1.0);
  float d =
    ${f(TONE_GAIN.shadows)} * u_tone.x * (1.0 - smoothstep(${f(TONE_EDGES.shadows[0])}, ${f(TONE_EDGES.shadows[1])}, vv)) +
    ${f(TONE_GAIN.highlights)} * u_tone.y * smoothstep(${f(TONE_EDGES.highlights[0])}, ${f(TONE_EDGES.highlights[1])}, vv) +
    ${f(TONE_GAIN.whites)} * u_tone.z * smoothstep(${f(TONE_EDGES.whites[0])}, ${f(TONE_EDGES.whites[1])}, vv) +
    ${f(TONE_GAIN.blacks)} * u_tone.w * (1.0 - smoothstep(${f(TONE_EDGES.blacks[0])}, ${f(TONE_EDGES.blacks[1])}, vv));
  return max(vc + d, 0.0);
}
vec3 stage_tone(vec3 c) {
  float y = dot(c, LUMA);
  return scaleToLuma(c, y, srgbToLinear(toneCurve(linearToSrgb(y))));
}`,

  local: `
uniform vec3 u_local; // texture, clarity, dehaze in [-1, 1]
uniform sampler2D u_blur0, u_blur1, u_blur2;
uniform vec3 u_bi0, u_bi1, u_bi2; // (downsample factor, low-res width, low-res height)
float sampleBlur(sampler2D t, vec3 info) { return texture(t, (g_px + 0.5) / (info.x * info.yz)).r; }
vec3 stage_local(vec3 c) {
  float bv0 = sampleBlur(u_blur0, u_bi0);
  float bv1 = sampleBlur(u_blur1, u_bi1);
  float bdark = sampleBlur(u_blur2, u_bi2);
  float y0 = dot(c, LUMA);
  float v0 = linearToSrgb(y0);
  vec3 o = c;
  if (u_local.z > 0.0) {
    float tr = max(1.0 - ${f(DEHAZE_OMEGA)} * u_local.z * (bdark / ${f(DEHAZE_AIRLIGHT)}), ${f(DEHAZE_MIN_T)});
    o = max((c - vec3(${f(DEHAZE_AIRLIGHT)})) / tr + vec3(${f(DEHAZE_AIRLIGHT)}), vec3(0.0));
  } else if (u_local.z < 0.0) {
    float k = -u_local.z * ${f(HAZE_ADD_MAX)};
    o = c + (vec3(${f(HAZE_ADD_LEVEL)}) - c) * k;
  }
  float y1 = dot(o, LUMA);
  float v = linearToSrgb(y1);
  float dt = v0 - bv0;
  float dc = v0 - bv1;
  float vc0 = clamp(v0, 0.0, 1.0);
  float mid = 4.0 * vc0 * (1.0 - vc0);
  v += ${f(TEXTURE_GAIN)} * u_local.x * dt + ${f(CLARITY_GAIN)} * u_local.y * mid * (dc / (1.0 + ${f(CLARITY_SOFTNESS)} * abs(dc)));
  v = max(v, 0.0);
  return scaleToLuma(o, y1, srgbToLinear(v));
}`,

  curve: `
uniform sampler2D u_lut;
vec3 stage_curve(vec3 c) {
  vec3 e = clamp(linearToSrgb3(c), 0.0, 1.0);
  vec3 t = (e * ${f(LUT_SIZE - 1)} + 0.5) / ${f(LUT_SIZE)};
  vec3 o = vec3(texture(u_lut, vec2(t.r, 0.5)).r, texture(u_lut, vec2(t.g, 0.5)).g, texture(u_lut, vec2(t.b, 0.5)).b);
  return srgbToLinear3(o);
}`,

  mixer: `
uniform float u_mixHue[8];
uniform float u_mixSat[8];
uniform float u_mixLum[8];
const float MIX_H[8] = float[8](${MIX_HUES.map(f).join(', ')});
vec3 stage_mixer(vec3 c) {
  vec3 cc = max(c, vec3(0.0));
  vec3 lab = linearToOklab(cc);
  float C = length(lab.yz);
  if (C < 1e-6) return cc;
  float h = degrees(atan(lab.z, lab.y));
  h = h - 360.0 * floor(h / 360.0);
  if (h < MIX_H[0]) h += 360.0;
  int a = 7;
  for (int i = 0; i < 7; i++) { if (h >= MIX_H[i] && h < MIX_H[i + 1]) { a = i; break; } }
  int b = (a + 1) % 8;
  float ha = MIX_H[a];
  float hb = (b == 0) ? MIX_H[0] + 360.0 : MIX_H[b];
  float t = smoothstep(0.0, 1.0, (h - ha) / (hb - ha));
  float wa = 1.0 - t, wb = t;
  float k = smoothstep(0.0, ${f(MIX_CHROMA_GATE)}, C);
  float dh = (wa * u_mixHue[a] + wb * u_mixHue[b]) * ${f(MIX_HUE_SHIFT_DEG)} * k;
  float ds = (wa * u_mixSat[a] + wb * u_mixSat[b]) * k;
  float dl = (wa * u_mixLum[a] + wb * u_mixLum[b]) * ${f(MIX_LUM_GAIN)} * k;
  float C2 = max(C * (1.0 + ds), 0.0);
  float h2 = radians(h + dh);
  return max(oklabToLinear(vec3(lab.x + dl, C2 * cos(h2), C2 * sin(h2))), vec3(0.0));
}`,

  grading: `
uniform vec4 u_gradeA, u_gradeB, u_gradeL; // per range [shadows, mid, highlights, global]
uniform vec2 u_gradeW; // balance shift, blending half-width
vec3 stage_grading(vec3 c) {
  vec3 cc = max(c, vec3(0.0));
  vec3 lab = linearToOklab(cc);
  float v = linearToSrgb(dot(cc, LUMA));
  float ws = 1.0 - smoothstep(0.3 + u_gradeW.x - u_gradeW.y, 0.3 + u_gradeW.x + u_gradeW.y, v);
  float wh = smoothstep(0.7 + u_gradeW.x - u_gradeW.y, 0.7 + u_gradeW.x + u_gradeW.y, v);
  vec4 w = vec4(ws, clamp(1.0 - ws - wh, 0.0, 1.0), wh, 1.0);
  vec3 o = vec3(lab.x + dot(w, u_gradeL), lab.y + dot(w, u_gradeA), lab.z + dot(w, u_gradeB));
  return max(oklabToLinear(o), vec3(0.0));
}`,

  color: `
uniform float u_sat;
uniform float u_vib;
vec3 stage_color(vec3 c) {
  float y = dot(c, LUMA);
  float mx = max(max(c.r, c.g), max(c.b, 0.0));
  float mn = max(min(min(c.r, c.g), c.b), 0.0);
  float chroma = clamp((mx - mn) / (mx + 1e-6), 0.0, 1.0);
  float s = max((1.0 + u_sat) * (1.0 + u_vib * (1.0 - chroma)), 0.0);
  return vec3(y) + (c - vec3(y)) * s;
}`,

  vignette: `
uniform vec4 u_vig0; // amount, start, width, roundness
uniform vec2 u_vig1; // highlights, aspect
vec3 stage_vignette(vec3 c) {
  float u = (g_px.x + 0.5) / g_size.x;
  float v = 1.0 - (g_px.y + 0.5) / g_size.y;
  float x = (u - 0.5) * 2.0, y = (v - 0.5) * 2.0;
  float r = u_vig0.w;
  if (r > 0.0) {
    if (u_vig1.y >= 1.0) y *= 1.0 + (1.0 / u_vig1.y - 1.0) * r;
    else x *= 1.0 + (u_vig1.y - 1.0) * r;
  }
  float n = 2.0 + 4.0 * max(-r, 0.0);
  float d = pow((pow(abs(x), n) + pow(abs(y), n)) / 2.0, 1.0 / n);
  float k = smoothstep(u_vig0.y, u_vig0.y + u_vig0.z, d);
  float gain = pow(2.0, u_vig0.x * k * ${f(VIGNETTE_STOPS)});
  if (u_vig0.x < 0.0 && u_vig1.x > 0.0) {
    float wh = smoothstep(0.4, 0.9, linearToSrgb(dot(c, LUMA)));
    gain = gain + (1.0 - gain) * u_vig1.x * wh;
  }
  return c * gain;
}`,

  grain: `
uniform vec3 u_grain; // amplitude, cell size (px), roughness
float hash2(uvec2 p) {
  uint h = (p.x * 1597334677u) ^ (p.y * 3812015801u);
  h = h ^ (h >> 16);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15);
  h = h * 0x846ca68bu;
  h = h ^ (h >> 16);
  return float(h >> 8) / 16777216.0;
}
float hn(ivec2 i) { return (hash2(uvec2(i)) - 0.5) * 2.0; }
vec3 stage_grain(vec3 c) {
  vec2 q = (g_px + 0.5) / u_grain.y;
  ivec2 i = ivec2(floor(q));
  vec2 fr = q - vec2(i);
  float soft = 1.5 * (mix(mix(hn(i), hn(i + ivec2(1, 0)), fr.x), mix(hn(i + ivec2(0, 1)), hn(i + ivec2(1, 1)), fr.x), fr.y));
  float fine = hn(ivec2(floor(g_px)));
  float n = soft + (fine - soft) * u_grain.z;
  float vc = clamp(linearToSrgb(dot(c, LUMA)), 0.0, 1.0);
  float weight = 0.25 + 0.75 * 4.0 * vc * (1.0 - vc);
  float d = n * u_grain.x * weight;
  return srgbToLinear3(max(linearToSrgb3(c) + vec3(d), vec3(0.0)));
}`,
};

export type ShaderSource = 'texture' | 'float';
export type ShaderOutput = 'display' | 'float';

/** Stage ids that have a uniform on/off flag (all of them; flags let one program serve any slider state). */
export function buildFragmentShader(stages: StageId[], source: ShaderSource = 'texture', output: ShaderOutput = 'display'): string {
  const defs = [...new Set(stages)].map((id) => STAGE_GLSL[id]).join('\n');
  const flags = [...new Set(stages)].map((id) => `uniform int u_on_${id};`).join('\n');
  const calls = stages.map((id) => `  if (u_on_${id} == 1) c = stage_${id}(c);`).join('\n');
  const fetch =
    source === 'texture'
      ? `  vec4 src = texture(u_tex, v_uv);\n  vec3 c = src.rgb; float alpha = src.a; // linear light`
      : `  vec4 src = texelFetch(u_a, ivec2(g_px), 0);\n  vec3 c = src.rgb; float alpha = src.a;`;
  const store =
    output === 'float'
      ? `  outColor = vec4(c, alpha);`
      : `  vec3 e = clamp(linearToSrgb3(c), 0.0, 1.0);
  if (u_clip == 1) {
    vec3 q = floor(e * 255.0 + 0.5);
    if (max(max(q.r, q.g), q.b) >= 255.0) e = vec3(1.0, 0.1, 0.1);
    else if (min(min(q.r, q.g), q.b) <= 0.0) e = vec3(0.1, 0.35, 1.0);
  }
  outColor = vec4(e, alpha);`;
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_tex;
uniform sampler2D u_a;
uniform int u_clip;
in vec2 v_uv;
out vec4 outColor;
${COMMON}
${flags}
${defs}
void main() {
  g_px = floor(gl_FragCoord.xy);
  g_size = u_size;
${fetch}
${calls}
${store}
}`;
}

/** Downsample (box, clamp-to-edge) a scalar quantity of the float image into a low-res target. */
export const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_a;
uniform int u_mode; // 0: perceptual luminance v, 1: dark channel
uniform int u_factor;
uniform ivec2 u_asize;
out vec4 outColor;
const vec3 LUMA = vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])});

float linearToSrgbQ(float x) {
  x = max(x, 0.0);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float s = 0.0;
  for (int fy = 0; fy < u_factor; fy++) {
    for (int fx = 0; fx < u_factor; fx++) {
      ivec2 q = min(p * u_factor + ivec2(fx, fy), u_asize - ivec2(1));
      vec3 c = texelFetch(u_a, q, 0).rgb;
      s += (u_mode == 0) ? linearToSrgbQ(dot(c, LUMA)) : max(min(min(c.r, c.g), c.b), 0.0);
    }
  }
  outColor = vec4(s / float(u_factor * u_factor), 0.0, 0.0, 1.0);
}`;

/** One direction of a clamp-to-edge Gaussian on the red channel. */
export const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_in;
uniform ivec2 u_dir;
uniform ivec2 u_lsize;
uniform float u_sigma;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int r = max(1, int(ceil(3.0 * u_sigma)));
  float s = 0.0, ws = 0.0;
  for (int i = -r; i <= r; i++) {
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    ivec2 q = clamp(p + u_dir * i, ivec2(0), u_lsize - ivec2(1));
    s += w * texelFetch(u_in, q, 0).r;
    ws += w;
  }
  outColor = vec4(s / ws, 0.0, 0.0, 1.0);
}`;

export type Uniform =
  | { k: 'i'; v: number }
  | { k: 'f'; v: number }
  | { k: 'v2' | 'v3' | 'v4'; v: number[] }
  | { k: 'fv'; v: number[] };

/** Translate derived values into shader uniforms. Stage on/off flags included. */
export function derivedToUniforms(d: Derived): Record<string, Uniform> {
  const u: Record<string, Uniform> = {
    u_size: { k: 'v2', v: [d.w, d.h] },
    u_wb: { k: 'v3', v: d.wb },
    u_expGain: { k: 'f', v: d.expGain },
    u_contrastShape: { k: 'f', v: d.contrastShape },
    u_tone: { k: 'v4', v: d.tone },
    u_local: { k: 'v3', v: [d.local.texture, d.local.clarity, d.local.dehaze] },
    u_bi0: { k: 'v3', v: [d.blur[0].factor, d.blur[0].lw, d.blur[0].lh] },
    u_bi1: { k: 'v3', v: [d.blur[1].factor, d.blur[1].lw, d.blur[1].lh] },
    u_bi2: { k: 'v3', v: [d.blur[2].factor, d.blur[2].lw, d.blur[2].lh] },
    u_mixHue: { k: 'fv', v: d.mixer.hue },
    u_mixSat: { k: 'fv', v: d.mixer.sat },
    u_mixLum: { k: 'fv', v: d.mixer.lum },
    u_gradeA: { k: 'v4', v: d.grade.a },
    u_gradeB: { k: 'v4', v: d.grade.b },
    u_gradeL: { k: 'v4', v: d.grade.l },
    u_gradeW: { k: 'v2', v: [d.grade.shift, d.grade.width] },
    u_sat: { k: 'f', v: d.sat },
    u_vib: { k: 'f', v: d.vib },
    u_vig0: { k: 'v4', v: [d.vignette.amount, d.vignette.start, d.vignette.width, d.vignette.roundness] },
    u_vig1: { k: 'v2', v: [d.vignette.highlights, d.vignette.aspect] },
    u_grain: { k: 'v3', v: [d.grain.amp, d.grain.cell, d.grain.rough] },
  };
  for (const [id, on] of Object.entries(d.active)) u[`u_on_${id}`] = { k: 'i', v: on ? 1 : 0 };
  return u;
}
