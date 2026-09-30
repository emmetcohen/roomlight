/**
 * WebGL2 renderer: original image texture + edit parameters -> pixels.
 *
 * The original is uploaded once as an sRGB texture and never modified. Rendering:
 *   - no neighbourhood stage active: ONE float shader pass straight to the target;
 *   - texture/clarity/dehaze active: pass 1 (stages before `local`) -> float target A,
 *     then for each of three blur fields: downsample -> Gaussian H -> Gaussian V (tiny
 *     targets), then pass 2 (`local` + later stages) reads A and the blur fields.
 * Intermediate targets are RGBA16F, so there is no 8-bit quantisation between adjustments.
 * `readback` renders the same pipeline into a small RGBA8 target so the histogram is
 * computed from what is actually rendered.
 */
import { BLUR_FRAGMENT, DOWNSAMPLE_FRAGMENT, VERTEX_SHADER, buildFragmentShader, derivedToUniforms, type ShaderOutput, type ShaderSource, type Uniform } from './glsl';
import { DEFAULT_PIPELINE, type StageId } from './pipeline';
import { LUT_SIZE } from './curves';
import { derive, lutFor, type Derived } from './derive';
import { outputSize } from '../geometry/transform';
import { RASTER_SIZE } from '../masks/brush';
import { MAX_RASTERS } from '../masks/types';
import type { EditParams } from './params';

/**
 * A window onto the output picture, for zoomed views. The output picture has a VIRTUAL size
 * (vw × vh, e.g. its size at 100 %); `region` = [x, y, w, h] is the part of it (output uv, y down)
 * that fills the canvas. Every effect is a function of output position, so a window shows exactly
 * what a full-size render would show there. Neighbourhood effects (texture, clarity, dehaze) take
 * their blur fields from a whole-picture render at fw × fh (≤ a few thousand px), which keeps them
 * consistent across the window without rendering the whole picture at full size.
 */
export interface ViewWindow { vw: number; vh: number; region: [number, number, number, number]; fw: number; fh: number }

export interface RenderOptions {
  showClipping?: boolean;
  /** Index into params.masks of the mask to tint red (the masking tool's overlay). */
  overlayMask?: number;
  view?: ViewWindow;
}
export interface Readback { data: Uint8Array; width: number; height: number } // RGBA8, bottom row first (GL convention)

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }
interface Slot { a: Target | null; aFull: Target | null; fullKey: { params: EditParams; tex: WebGLTexture; fw: number; fh: number } | null; down: (Target | null)[]; tmp: (Target | null)[]; blur: (Target | null)[] }
interface Program { prog: WebGLProgram; locs: Map<string, WebGLUniformLocation | null> }

const UNIT = { tex: 0, lut: 1, a: 2, blur0: 3, blur1: 4, blur2: 5 } as const;
const BRUSH_UNIT = 6;

export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  /** False when the GPU cannot render to float textures: texture/clarity/dehaze are then skipped. */
  readonly supportsLocal: boolean;
  private vao: WebGLVertexArrayObject;
  private programs = new Map<string, Program>();
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutSource: Float32Array | null = null;
  private brushTex: WebGLTexture | null = null;
  private uploadedRasters: (Uint8Array | null)[] = new Array(MAX_RASTERS).fill(null);
  private order: StageId[] = DEFAULT_PIPELINE;
  private slots: Record<'display' | 'readback', Slot> = { display: emptySlot(), readback: emptySlot() };
  private readFbo: { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
  imageSize = { width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.supportsLocal = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create vertex array.');
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** Change stage order (programs are rebuilt lazily). */
  setPipeline(order: StageId[]): void {
    this.order = order;
    for (const p of this.programs.values()) this.gl.deleteProgram(p.prog);
    this.programs.clear();
  }

  // ------------------------------------------------------------------ resources

  private program(key: string, frag: () => string): Program {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, frag()));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    p = { prog, locs: new Map() };
    this.programs.set(key, p);
    return p;
  }

  private stageProgram(stages: StageId[], source: ShaderSource, output: ShaderOutput): Program {
    return this.program(`${stages.join(',')}|${source}|${output}`, () => buildFragmentShader(stages, source, output));
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.locs.has(name)) p.locs.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.locs.get(name)!;
  }

  private makeTarget(w: number, h: number, internal: number, format: number, type: number, filter: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Float render target is not supported by this GPU.');
    return { tex, fbo, w, h };
  }

  private floatTarget(old: Target | null, w: number, h: number): Target {
    if (old && old.w === w && old.h === h) return old;
    if (old) this.freeTarget(old);
    const gl = this.gl;
    return this.makeTarget(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
  }

  private freeTarget(t: Target) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  /** Upload the original image. Decoded 8-bit sRGB is interpreted by the GPU as sRGB. */
  setImage(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // orientation handled in the vertex shader
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    this.imageSize = { width: source.width, height: source.height };
  }

  private uploadLut(lut: Float32Array) {
    if (this.lutSource === lut && this.lutTex) return;
    const gl = this.gl;
    if (!this.lutTex) {
      this.lutTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, lut);
    this.lutSource = lut;
  }

  /** Turn mip-mapped minification off (LINEAR only). Used by the parity test so CPU and GPU sample identically. */
  useMipmaps(on: boolean): void {
    const gl = this.gl;
    if (!this.tex) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, on ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  }

  /** Mask rasters (brush / segmentation) live in one 2D array texture, one layer per raster. */
  private uploadRasters(rasters: Uint8Array[]) {
    const gl = this.gl;
    if (!this.brushTex) {
      this.brushTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, RASTER_SIZE, RASTER_SIZE, MAX_RASTERS);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    rasters.forEach((r, i) => {
      if (this.uploadedRasters[i] === r) return; // rasters are cached per stroke list: identity = unchanged
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, RASTER_SIZE, RASTER_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, r);
      this.uploadedRasters[i] = r;
    });
  }

  // ------------------------------------------------------------------ drawing

  private bind(units: Partial<Record<keyof typeof UNIT, WebGLTexture | null>>) {
    const gl = this.gl;
    for (const [name, unit] of Object.entries(UNIT)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, units[name as keyof typeof UNIT] ?? null);
    }
    gl.activeTexture(gl.TEXTURE0 + BRUSH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
  }

  private setUniforms(p: Program, u: Record<string, Uniform>, clip: boolean) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    for (const [name, sampler] of Object.entries(UNIT)) { const l = this.loc(p, 'u_' + name); if (l) gl.uniform1i(l, sampler); }
    const lb = this.loc(p, 'u_brush'); if (lb) gl.uniform1i(lb, BRUSH_UNIT);
    const lc = this.loc(p, 'u_clip'); if (lc) gl.uniform1i(lc, clip ? 1 : 0);
    for (const [name, x] of Object.entries(u)) {
      const l = this.loc(p, name);
      if (!l) continue; // stage not in this program
      switch (x.k) {
        case 'i': gl.uniform1i(l, x.v); break;
        case 'f': gl.uniform1f(l, x.v); break;
        case 'v2': gl.uniform2fv(l, x.v); break;
        case 'v3': gl.uniform3fv(l, x.v); break;
        case 'v4': gl.uniform4fv(l, x.v); break;
        case 'fv': gl.uniform1fv(l, x.v); break;
        case 'v4v': if (x.v.length) gl.uniform4fv(l, x.v); break;
        case 'm3': gl.uniformMatrix3fv(l, false, x.v); break;
      }
    }
  }

  private draw(fbo: WebGLFramebuffer | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Downsample + Gaussian blur the three fields from a float image (of size w × h) into slot.blur[0..2]. */
  private buildBlurFields(slot: Slot, source: Target, d: Derived, w: number, h: number) {
    const gl = this.gl;
    const down = this.program('down', () => DOWNSAMPLE_FRAGMENT);
    const blurP = this.program('blur', () => BLUR_FRAGMENT);
    for (let i = 0; i < 3; i++) {
      const spec = d.blur[i];
      const dn = (slot.down[i] = this.floatTarget(slot.down[i], spec.lw, spec.lh));
      const tm = (slot.tmp[i] = this.floatTarget(slot.tmp[i], spec.lw, spec.lh));
      const bl = (slot.blur[i] = this.floatTarget(slot.blur[i], spec.lw, spec.lh));
      gl.useProgram(down.prog);
      this.bind({ a: source.tex });
      gl.uniform1i(this.loc(down, 'u_a'), UNIT.a);
      gl.uniform1i(this.loc(down, 'u_mode'), i < 2 ? 0 : 1);
      gl.uniform1i(this.loc(down, 'u_factor'), spec.factor);
      gl.uniform2i(this.loc(down, 'u_asize'), w, h);
      this.draw(dn.fbo, spec.lw, spec.lh);
      for (const [src, dst, dir] of [[dn, tm, [1, 0]], [tm, bl, [0, 1]]] as const) {
        gl.useProgram(blurP.prog);
        this.bind({ a: src.tex });
        gl.uniform1i(this.loc(blurP, 'u_in'), UNIT.a);
        gl.uniform2i(this.loc(blurP, 'u_dir'), dir[0], dir[1]);
        gl.uniform2i(this.loc(blurP, 'u_lsize'), spec.lw, spec.lh);
        gl.uniform1f(this.loc(blurP, 'u_sigma'), spec.sigmaLow);
        this.draw(dst.fbo, spec.lw, spec.lh);
      }
    }
  }

  private run(params: EditParams, w: number, h: number, dest: WebGLFramebuffer | null, slot: Slot, clip: boolean, overlayMask = -1, view?: ViewWindow) {
    if (!this.tex) return;
    const src = { w: this.imageSize.width, h: this.imageSize.height };
    // Without a view, the drawn size IS the virtual size. With one, the virtual size is the picture's size at the zoom level.
    const d = derive(params, view?.vw ?? w, view?.vh ?? h, src, view ? { w: view.fw, h: view.fh } : { w, h });
    this.uploadLut(lutFor(params));
    this.uploadRasters(d.masks.rasters);
    const overlay = overlayMask >= 0 ? d.masks.source.indexOf(overlayMask) : -1;
    const u = derivedToUniforms(d, overlay, view?.region);
    const useLocal = d.active.local && this.supportsLocal && this.order.includes('local');
    const order = this.order;

    if (!useLocal) {
      const stages = order.filter((s) => s !== 'local');
      const p = this.stageProgram(stages, 'texture', 'display');
      this.bind({ tex: this.tex, lut: this.lutTex });
      this.setUniforms(p, u, clip);
      this.draw(dest, w, h);
      return;
    }

    const li = order.indexOf('local');
    const p1 = this.stageProgram(order.slice(0, li), 'texture', 'float');
    this.bind({ tex: this.tex, lut: this.lutTex });

    if (view) {
      // Blur fields from a whole-picture render (cached until the edit, the source or the size changes)
      const k = slot.fullKey;
      if (!slot.aFull || !k || k.params !== params || k.tex !== this.tex || k.fw !== view.fw || k.fh !== view.fh) {
        const af = (slot.aFull = this.floatTarget(slot.aFull, view.fw, view.fh));
        this.setUniforms(p1, derivedToUniforms(d, -1), false);
        this.draw(af.fbo, view.fw, view.fh);
        this.buildBlurFields(slot, af, d, view.fw, view.fh);
        slot.fullKey = { params, tex: this.tex, fw: view.fw, fh: view.fh };
      }
    }

    // Pass 1: everything before `local` -> A (linear float) for the window being drawn
    const a = (slot.a = this.floatTarget(slot.a, w, h));
    this.bind({ tex: this.tex, lut: this.lutTex });
    this.setUniforms(p1, u, false);
    this.draw(a.fbo, w, h);
    if (!view) this.buildBlurFields(slot, a, d, w, h);

    // Pass 2: `local` and everything after, reading A + blur fields
    const p2 = this.stageProgram(order.slice(li), 'float', 'display');
    this.bind({ tex: this.tex, lut: this.lutTex, a: a.tex, blur0: slot.blur[0]!.tex, blur1: slot.blur[1]!.tex, blur2: slot.blur[2]!.tex });
    this.setUniforms(p2, u, clip);
    this.draw(dest, w, h);
  }

  /** Render to the canvas' default framebuffer (canvas pixel size = drawing size). */
  render(params: EditParams, opts: RenderOptions = {}): void {
    const gl = this.gl;
    this.run(params, gl.drawingBufferWidth, gl.drawingBufferHeight, null, this.slots.display, !!opts.showClipping, opts.overlayMask ?? -1, opts.view);
  }

  /** Largest texture / render target edge this GPU supports. */
  get maxSize(): number {
    return Math.min(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number, this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) as number);
  }

  /** Render into an offscreen RGBA8 target whose long edge is ≤ maxDim and read the pixels. */
  readback(params: EditParams, maxDim = 256): Readback {
    const { w, h } = outputSize(params, this.imageSize.width, this.imageSize.height, maxDim);
    return this.readbackSize(params, w, h);
  }

  /** Render the whole output picture at exactly w × h (any size, up or down) and read it back (RGBA8, bottom row first). Used by export. */
  readbackSize(params: EditParams, w: number, h: number): Readback {
    const gl = this.gl;
    if (!this.readFbo || this.readFbo.w !== w || this.readFbo.h !== h) {
      if (this.readFbo) { gl.deleteTexture(this.readFbo.tex); gl.deleteFramebuffer(this.readFbo.fbo); }
      const t = this.makeTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
      this.readFbo = { fbo: t.fbo, tex: t.tex, w, h };
    }
    this.run(params, w, h, this.readFbo.fbo, this.slots.readback, false);
    const data = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, width: w, height: h };
  }

  dispose(): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.brushTex) gl.deleteTexture(this.brushTex);
    for (const s of Object.values(this.slots)) for (const t of [s.a, s.aFull, ...s.down, ...s.tmp, ...s.blur]) if (t) this.freeTarget(t);
    if (this.readFbo) { gl.deleteTexture(this.readFbo.tex); gl.deleteFramebuffer(this.readFbo.fbo); }
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.tex = this.lutTex = null;
    this.programs.clear();
  }
}

function emptySlot(): Slot {
  return { a: null, aFull: null, fullKey: null, down: [null, null, null], tmp: [null, null, null], blur: [null, null, null] };
}
