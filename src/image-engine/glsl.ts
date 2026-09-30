/**
 * GLSL (WebGL2 / GLSL ES 3.00) implementation of the pipeline, generated from the stage
 * order. The formulas mirror model.ts; constants are interpolated from the same source.
 *
 * The source texture is SRGB8_ALPHA8, so the sampler returns *linear light* directly and
 * mip-mapping/filtering happens in linear space (correct downscaling).
 */
import { RATIO_FLOOR, TONE_EDGES, TONE_GAIN } from './model';
import { LUMA } from '../color/colorSpace';
import type { EditParams } from './params';
import { contrastShape, exposureGain, wbMultipliers } from './model';
import type { StageId } from './pipeline';

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
float srgbToLinear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float linearToSrgb(float x) {
  x = max(x, 0.0);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
vec3 linearToSrgb3(vec3 c) { return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b)); }
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
  float y2 = srgbToLinear(toneCurve(linearToSrgb(y)));
  float w = clamp(y / ${f(RATIO_FLOOR)}, 0.0, 1.0);
  float k = y2 / max(y, 1e-6);
  return vec3(y2) + (c * k - vec3(y2)) * w;
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
};

export function buildFragmentShader(order: StageId[]): string {
  const defs = [...new Set(order)].map((id) => STAGE_GLSL[id]).join('\n');
  const calls = order.map((id) => `  c = stage_${id}(c);`).join('\n');
  return `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_clip; // 0 off, 1 show clipping
in vec2 v_uv;
out vec4 outColor;
${COMMON}
${defs}
void main() {
  vec4 src = texture(u_tex, v_uv);
  vec3 c = src.rgb; // linear light
${calls}
  vec3 e = clamp(linearToSrgb3(c), 0.0, 1.0);
  if (u_clip == 1) {
    vec3 q = floor(e * 255.0 + 0.5);
    if (max(max(q.r, q.g), q.b) >= 255.0) e = vec3(1.0, 0.1, 0.1);
    else if (min(min(q.r, q.g), q.b) <= 0.0) e = vec3(0.1, 0.35, 1.0);
  }
  outColor = vec4(e, src.a);
}`;
}

export type UniformValue = number | number[];

/** Translate edit parameters into shader uniforms. Derived values are computed here in JS. */
export function paramsToUniforms(p: EditParams): Record<string, UniformValue> {
  return {
    u_wb: wbMultipliers(p.temperature, p.tint),
    u_expGain: exposureGain(p.exposure),
    u_contrastShape: contrastShape(p.contrast),
    u_tone: [p.shadows / 100, p.highlights / 100, p.whites / 100, p.blacks / 100],
    u_sat: p.saturation / 100,
    u_vib: p.vibrance / 100,
  };
}

