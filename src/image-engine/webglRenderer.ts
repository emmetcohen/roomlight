/**
 * WebGL2 renderer: original image texture + edit parameters -> pixels.
 *
 * The original is uploaded once as an sRGB texture and never modified; every render is a
 * single full-float shader pass over it, so there is no intermediate 8-bit quantisation
 * between adjustments. `readback` renders the same program into a small framebuffer so
 * the histogram is computed from the actual rendered output.
 */
import { DEFAULT_PIPELINE, type StageId } from './pipeline';
import { VERTEX_SHADER, buildFragmentShader, paramsToUniforms } from './glsl';
import type { EditParams } from './params';

export interface RenderOptions {
  showClipping?: boolean;
}

export interface Readback {
  data: Uint8Array; // RGBA8, bottom row first (GL convention)
  width: number;
  height: number;
}

export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture | null = null;
  private uniformLocs = new Map<string, WebGLUniformLocation | null>();
  private order: StageId[] = DEFAULT_PIPELINE;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboSize = { w: 0, h: 0 };
  imageSize = { width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create vertex array.');
    this.vao = vao;
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.compile();
    const loc = gl.getAttribLocation(this.program!, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  /** Change stage order (recompiles the shader). */
  setPipeline(order: StageId[]): void {
    this.order = order;
    this.compile();
  }

  private compile(): void {
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
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, buildFragmentShader(this.order)));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.uniformLocs.clear();
  }

  /** Upload the original image. Decoded 8-bit sRGB is interpreted by the GPU as sRGB. */
  setImage(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): void {
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
    this.imageSize = { width: (source as ImageBitmap).width, height: (source as ImageBitmap).height };
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.uniformLocs.has(name)) this.uniformLocs.set(name, this.gl.getUniformLocation(this.program!, name));
    return this.uniformLocs.get(name)!;
  }

  private draw(params: EditParams, opts: RenderOptions): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc('u_tex'), 0);
    gl.uniform1i(this.loc('u_clip'), opts.showClipping ? 1 : 0);
    for (const [name, v] of Object.entries(paramsToUniforms(params))) {
      const l = this.loc(name);
      if (l === null) continue; // stage not in the current pipeline
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (v.length === 3) gl.uniform3fv(l, v);
      else if (v.length === 4) gl.uniform4fv(l, v);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Render to the canvas' default framebuffer (canvas pixel size = drawing size). */
  render(params: EditParams, opts: RenderOptions = {}): void {
    if (!this.tex) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    this.draw(params, opts);
  }

  /** Render into an offscreen target whose long edge is ≤ maxDim and read the pixels. */
  readback(params: EditParams, maxDim = 256): Readback {
    const gl = this.gl;
    const { width, height } = this.imageSize;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (!this.fbo || this.fboSize.w !== w || this.fboSize.h !== h) {
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      this.fboTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      this.fboSize = { w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    this.draw(params, {});
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data, width: w, height: h };
  }

  dispose(): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.program) gl.deleteProgram(this.program);
  }
}
