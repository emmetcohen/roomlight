/** Dev-only page used by scripts/verify-gpu.mjs: GPU shader output vs the CPU reference. */
import { DEFAULT_PARAMS, normalizeParams, type EditParams } from '../image-engine/params';
import { renderImage } from '../image-engine/pipeline';
import { linearToOklab } from '../image-engine/oklab';
import { srgbToLinear } from '../color/colorSpace';
import { WebGLRenderer } from '../image-engine/webglRenderer';

const W = 96, H = 72;

/** Deterministic test scene: sky gradient, ground, colour patches, a grey ramp, fine + coarse texture. */
function makeSource(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r: number, g: number, b: number;
    if (y < 30) { const t = y / 30; r = 40 + 180 * t; g = 95 + 130 * t; b = 175 + 60 * t; }
    else if (y < 54) { const t = (y - 30) / 24; r = 140 - 90 * t; g = 105 - 70 * t; b = 60 - 40 * t; }
    else { const v = Math.round((x / (W - 1)) * 255); r = g = b = v; }
    if (y >= 36 && y < 50) {
      const patch = Math.floor(x / 12);
      const cols = [[220, 50, 50], [240, 140, 40], [230, 210, 50], [60, 180, 80], [50, 190, 200], [60, 90, 220], [140, 70, 210], [220, 70, 190]];
      if (patch < 8 && x % 12 < 10) [r, g, b] = cols[patch];
    }
    if ((x >> 1) % 2 === (y >> 1) % 2 && y > 10 && y < 26 && x > 60) { r *= 0.8; g *= 0.8; b *= 0.8; } // fine checker
    if (x > 30 && x < 54 && y > 4 && y < 28) { r = 235; g = 232; b = 225; } // bright block (hard edges)
    const o = (y * W + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}

/** Cases may give a colour-range target as `labFrom: [r, g, b]` (0-255); resolve it to OKLab here. */
function resolve(c: Record<string, unknown>): Record<string, unknown> {
  const masks = c.masks as { components: { shape: Record<string, unknown> }[] }[] | undefined;
  if (!masks) return c;
  for (const m of masks) for (const comp of m.components) {
    const from = comp.shape.labFrom as number[] | undefined;
    if (from) {
      const [L, a, b] = linearToOklab([srgbToLinear(from[0] / 255), srgbToLinear(from[1] / 255), srgbToLinear(from[2] / 255)]);
      Object.assign(comp.shape, { L, a, b });
    }
  }
  return c;
}

(window as unknown as Record<string, unknown>).runParity = (cases: Record<string, unknown>[]) => {
  const src = makeSource();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d')!.putImageData(new ImageData(src as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  const gl = new WebGLRenderer(document.getElementById('c') as HTMLCanvasElement);
  gl.setImage(canvas);
  gl.useMipmaps(false);
  const base = renderImage(src, W, H, DEFAULT_PARAMS);
  return cases.map((raw) => {
    const c = resolve(JSON.parse(JSON.stringify(raw)));
    const p: EditParams = normalizeParams({ ...DEFAULT_PARAMS, ...c });
    const cpu = renderImage(src, W, H, p);
    const rb = gl.readback(p, 256);
    const sameSize = cpu.width === rb.width && cpu.height === rb.height;
    let max = 0, sum = 0, big = 0, effect = 0;
    if (sameSize) for (let y = 0; y < cpu.height; y++) for (let x = 0; x < cpu.width; x++) {
      const g = ((cpu.height - 1 - y) * cpu.width + x) * 4; // GL readback is bottom-up
      const s = (y * cpu.width + x) * 4;
      for (let k = 0; k < 4; k++) {
        if (cpu.width === W && cpu.height === H) effect += Math.abs(cpu.data[s + k] - base.data[s + k]);
        const d = Math.abs(rb.data[g + k] - cpu.data[s + k]); max = Math.max(max, d); sum += d; if (d > 2) big++;
      }
    } else { max = 255; }
    if (cpu.width !== W || cpu.height !== H) effect = 99; // a crop changes the image by definition
    return {
      params: raw, maxDiff: max, meanDiff: sum / (cpu.width * cpu.height * 4), effect: cpu.width === W && cpu.height === H ? effect / (W * H * 4) : effect,
      pixelsOver2: big, size: [rb.width, rb.height], cpuSize: [cpu.width, cpu.height], localSupported: gl.supportsLocal,
    };
  });
};
