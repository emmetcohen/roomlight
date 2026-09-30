/** Dev-only page used by scripts/verify-gpu.mjs: GPU shader output vs the CPU reference. */
import { DEFAULT_PARAMS, type EditParams } from '../image-engine/params';
import { renderImageData } from '../image-engine/pipeline';
import { WebGLRenderer } from '../image-engine/webglRenderer';

const W = 47, H = 11; // 517 pixels: grey ramp, colour ramp, some patches

function makeSource(): Uint8ClampedArray {
  const px: number[] = [];
  for (let i = 0; i < 256; i++) px.push(i, i, i, 255);
  for (let i = 0; i < 256; i++) px.push(i, 255 - i, (i * 7) % 256, 255);
  for (const c of [[200, 120, 80], [40, 90, 200], [10, 10, 10], [250, 250, 245], [128, 128, 128]]) px.push(...c, 255);
  return new Uint8ClampedArray(px);
}

(window as unknown as Record<string, unknown>).runParity = (cases: Partial<EditParams>[]) => {
  const src = makeSource();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d')!.putImageData(new ImageData(src as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  const gl = new WebGLRenderer(document.getElementById('c') as HTMLCanvasElement);
  gl.setImage(canvas);
  return cases.map((c) => {
    const p = { ...DEFAULT_PARAMS, ...c };
    const cpu = renderImageData(src, p);
    const rb = gl.readback(p, 256);
    let max = 0, sum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const g = ((H - 1 - y) * W + x) * 4; // GL readback is bottom-up
      const s = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) { const d = Math.abs(rb.data[g + k] - cpu[s + k]); max = Math.max(max, d); sum += d; }
    }
    return { params: c, maxDiff: max, meanDiff: sum / (W * H * 3), size: [rb.width, rb.height] };
  });
};
