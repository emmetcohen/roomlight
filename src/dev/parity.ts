/** Dev-only page used by scripts/verify-gpu.mjs: GPU shader output vs the CPU reference. */
import { DEFAULT_PARAMS, normalizeParams, type EditParams } from '../image-engine/params';
import { renderImageData } from '../image-engine/pipeline';
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

(window as unknown as Record<string, unknown>).runParity = (cases: Record<string, unknown>[]) => {
  const src = makeSource();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d')!.putImageData(new ImageData(src as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  const gl = new WebGLRenderer(document.getElementById('c') as HTMLCanvasElement);
  gl.setImage(canvas);
  return cases.map((c) => {
    const p: EditParams = normalizeParams({ ...DEFAULT_PARAMS, ...c });
    const cpu = renderImageData(src, W, H, p);
    const rb = gl.readback(p, 256);
    let max = 0, sum = 0, big = 0, effect = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const g = ((H - 1 - y) * W + x) * 4; // GL readback is bottom-up
      const s = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) { effect += Math.abs(cpu[s + k] - src[s + k]); const d = Math.abs(rb.data[g + k] - cpu[s + k]); max = Math.max(max, d); sum += d; if (d > 2) big++; }
    }
    return { params: c, maxDiff: max, meanDiff: sum / (W * H * 3), effect: effect / (W * H * 3), pixelsOver2: big, size: [rb.width, rb.height], localSupported: gl.supportsLocal };
  });
};
