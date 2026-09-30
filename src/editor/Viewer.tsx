import { useEffect, useMemo, useRef, useState } from 'react';
import { makeGeoMap, outputSize } from '../geometry/transform';
import { DEFAULT_PARAMS } from '../image-engine/params';
import { computeHistogram } from '../image-engine/histogram';
import { WebGLRenderer } from '../image-engine/webglRenderer';
import { CropOverlay } from './CropOverlay';
import { MaskOverlay } from './MaskOverlay';
import { RetouchOverlay } from './RetouchOverlay';
import { retouchedPixels } from '../retouch/source';
import { publishHistogram } from './histogramStore';
import { store, useEditor } from './store';

/**
 * Canvas viewer. Owns the WebGL renderer; on any change to (image, params, view flags) it
 * re-renders original + parameters and publishes a histogram of the rendered output.
 *
 * - Edit / Masking tools show the CROPPED result (the crop is just a parameter).
 * - The Crop tool shows the whole rotated canvas with the crop rectangle on top, so the
 *   original pixels are always available to re-crop.
 */
export function Viewer() {
  const image = useEditor((s) => s.image);
  const params = useEditor((s) => s.params);
  const showOriginal = useEditor((s) => s.showOriginal);
  const showClipping = useEditor((s) => s.showClipping);
  const eyedropper = useEditor((s) => s.eyedropper);
  const loading = useEditor((s) => s.loading);
  const tool = useEditor((s) => s.tool);
  const selectedMask = useEditor((s) => s.selectedMask);
  const showOverlay = useEditor((s) => s.showOverlay);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // What to draw: the edit, or the untouched original (crop and all).
  const renderParams = useMemo(() => {
    const p = showOriginal ? DEFAULT_PARAMS : params;
    return tool === 'crop' && !showOriginal ? { ...p, crop: { ...p.crop, x: 0, y: 0, w: 1, h: 1 } } : p;
  }, [params, showOriginal, tool]);

  // Output aspect follows the crop / orientation.
  const bw = image?.bitmap.width ?? 1, bh = image?.bitmap.height ?? 1;
  const out = useMemo(() => outputSize(renderParams, bw, bh), [renderParams, bw, bh]);
  const ar = out.w / out.h;
  const pad = 24;
  const aw = Math.max(0, box.w - pad * 2), ah = Math.max(0, box.h - pad * 2);
  const cssW = Math.floor(Math.min(aw, ah * ar));
  const cssH = Math.floor(cssW / ar);

  // The renderer reads the original with retouch spots applied (a derived cache; the original is untouched).
  // "Before" shows the genuine original.
  const retouched = useMemo(() => (image && !showOriginal && params.spots.length ? retouchedPixels(image.pixels, params.spots) : null), [image, showOriginal, params.spots]);
  const sourceKey = retouched?.changed ? retouched.data : null;

  useEffect(() => {
    if (!image) return;
    try {
      rendererRef.current ??= new WebGLRenderer(canvasRef.current!);
      if (retouched?.changed) rendererRef.current.setImage(new ImageData(retouched.data as Uint8ClampedArray<ArrayBuffer>, image.pixels.width, image.pixels.height));
      else rendererRef.current.setImage(image.bitmap);
      if (!rendererRef.current.supportsLocal) setNote('This GPU cannot render to float textures: Texture, Clarity and Dehaze are disabled.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [image, sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { rendererRef.current?.dispose(); rendererRef.current = null; }, []);

  const overlayIndex = tool === 'mask' && showOverlay && !showOriginal ? params.masks.findIndex((m) => m.id === selectedMask) : -1;

  // Render whenever inputs change (coalesced to one render per animation frame).
  useEffect(() => {
    const r = rendererRef.current;
    const canvas = canvasRef.current;
    if (!r || !canvas || !image || cssW < 2 || cssH < 2) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      r.render(renderParams, { showClipping, overlayMask: overlayIndex });
      const rb = r.readback(renderParams, 256);
      publishHistogram(computeHistogram(rb.data));
    });
    return () => cancelAnimationFrame(frame.current);
  }, [image, sourceKey, renderParams, showClipping, cssW, cssH, overlayIndex]);

  useEffect(() => { if (!image) publishHistogram(null); }, [image]);

  const geo = useMemo(() => makeGeoMap(params, bw, bh), [params, bw, bh]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!eyedropper || tool !== 'edit') return;
    const rect = e.currentTarget.getBoundingClientRect();
    store.pickWhiteBalance((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };

  return (
    <div className="viewer" ref={wrapRef}>
      {error && <div className="viewer-error">{error}</div>}
      <div className="stage" style={{ width: cssW, height: cssH, display: image && !error ? 'block' : 'none' }}>
        <canvas
          ref={canvasRef}
          className={`viewer-canvas${eyedropper && tool === 'edit' ? ' picking' : ''}`}
          style={{ width: cssW, height: cssH }}
          onClick={onClick}
          data-testid="viewer-canvas"
        />
        {image && tool === 'crop' && !showOriginal && <CropOverlay width={cssW} height={cssH} />}
        {image && tool === 'retouch' && !showOriginal && <RetouchOverlay width={cssW} height={cssH} geo={geo} />}
        {image && tool === 'mask' && !showOriginal && <MaskOverlay width={cssW} height={cssH} geo={geo} srcW={bw} srcH={bh} />}
      </div>
      {showOriginal && image && <div className="badge">Original</div>}
      {loading && <div className="badge busy">Loading…</div>}
      {note && <div className="badge warn">{note}</div>}
    </div>
  );
}
