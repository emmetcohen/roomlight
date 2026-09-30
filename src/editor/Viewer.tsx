import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeGeoMap, outputSize } from '../geometry/transform';
import { DEFAULT_PARAMS } from '../image-engine/params';
import { computeHistogram } from '../image-engine/histogram';
import { WebGLRenderer, type ViewWindow } from '../image-engine/webglRenderer';
import { pixelsOf, retouchedPixels } from '../retouch/source';
import { CropOverlay } from './CropOverlay';
import { MaskOverlay } from './MaskOverlay';
import { RetouchOverlay } from './RetouchOverlay';
import { publishHistogram } from './histogramStore';
import { store, useEditor } from './store';
import { IDENTITY_VIEW, fitScale, panBy, regionFor, screenToOutput, zoomAt } from './viewMath';

/** Longest edge of the whole-picture render that supplies blur fields to a zoomed window. */
const BLUR_SOURCE_MAX = 3072;

/**
 * Canvas viewer. Owns the WebGL renderer; on any change to (image, params, view flags) it
 * re-renders original + parameters and publishes a histogram of the rendered output.
 *
 * - Edit / Retouch / Masking tools show the CROPPED result (the crop is just a parameter).
 * - The Crop tool shows the whole rotated canvas with the crop rectangle on top.
 * - Zoom: wheel (around the cursor), the Fit / 100 % / 200 % buttons, or Z. Above the preview's
 *   resolution the original is decoded at full size and the renderer draws just the visible window
 *   of it. Drag to pan (Edit tool; in the other tools hold Space or use the middle button).
 */
export function Viewer() {
  const image = useEditor((s) => s.image);
  const photo = useEditor((s) => s.photos.find((p) => p.id === s.currentId));
  const params = useEditor((s) => s.params);
  const showOriginal = useEditor((s) => s.showOriginal);
  const showClipping = useEditor((s) => s.showClipping);
  const eyedropper = useEditor((s) => s.eyedropper);
  const loading = useEditor((s) => s.loading);
  const tool = useEditor((s) => s.tool);
  const selectedMask = useEditor((s) => s.selectedMask);
  const showOverlay = useEditor((s) => s.showOverlay);
  const zoom = useEditor((s) => s.zoom);
  const fullRes = useEditor((s) => s.fullRes);
  const fullResLoading = useEditor((s) => s.fullResLoading);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const frame = useRef(0);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

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

  // ---- geometry of the view
  const bw = image?.bitmap.width ?? 1, bh = image?.bitmap.height ?? 1;
  const origW = photo?.width ?? bw, origH = photo?.height ?? bh;
  const out = useMemo(() => outputSize(renderParams, bw, bh), [renderParams, bw, bh]); // preview-resolution output (sets the fit aspect)
  const native = useMemo(() => outputSize(renderParams, origW, origH), [renderParams, origW, origH]); // full-resolution output
  const ar = out.w / out.h;
  const pad = 24;
  const aw = Math.max(0, box.w - pad * 2), ah = Math.max(0, box.h - pad * 2);
  const fitW = Math.floor(Math.min(aw, ah * ar)), fitH = Math.floor(fitW / ar);
  const zFit = fitScale(native.w, native.h, aw * dpr, ah * dpr);
  const zoomAllowed = tool !== 'crop';
  const zoomed = zoomAllowed && zoom.z !== null && zoom.z > zFit * 1.0001;
  const z = zoomed ? zoom.z! : null;
  const cssW = zoomed ? box.w : fitW, cssH = zoomed ? box.h : fitH;
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  const region = useMemo(() => (z ? regionFor(z, zoom.cx, zoom.cy, native.w, native.h, pw, ph) : null), [z, zoom.cx, zoom.cy, native.w, native.h, pw, ph]);
  const view = region ?? IDENTITY_VIEW;
  const viewWindow = useMemo<ViewWindow | undefined>(() => {
    if (!z || !region) return undefined;
    const vw = native.w * z, vh = native.h * z, k = Math.min(1, BLUR_SOURCE_MAX / Math.max(vw, vh));
    return { vw, vh, region: [region.ox, region.oy, region.sx, region.sy], fw: Math.max(1, Math.round(vw * k)), fh: Math.max(1, Math.round(vh * k)) };
  }, [z, region, native.w, native.h]);

  // ---- which pixels the renderer reads: preview or full resolution, with retouch spots applied (a derived cache; the original is untouched)
  const previewScale = Math.min(1, bw / origW);
  const needFull = !!z && previewScale < 0.999 && z > previewScale;
  const useFull = needFull && !!fullRes && fullRes.photoId === image?.photoId;
  const baseBitmap = useFull ? fullRes!.bitmap : image?.bitmap ?? null;
  const retouched = useMemo(() => {
    if (!image || showOriginal || !params.spots.length) return null;
    return retouchedPixels(useFull ? pixelsOf(fullRes!.bitmap) : image.pixels, params.spots);
  }, [image, showOriginal, params.spots, useFull, fullRes]);
  const sourceKey = retouched?.changed ? retouched.data : baseBitmap;

  useEffect(() => {
    if (needFull) void store.ensureFullRes(rendererRef.current?.maxSize ?? 8192);
    else if (fullRes) store.releaseFullRes();
  }, [needFull, image]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!image || !baseBitmap) return;
    try {
      rendererRef.current ??= new WebGLRenderer(canvasRef.current!);
      const r = rendererRef.current;
      if (retouched?.changed) {
        const w = useFull ? fullRes!.bitmap.width : image.pixels.width, h = useFull ? fullRes!.bitmap.height : image.pixels.height;
        r.setImage(new ImageData(retouched.data as Uint8ClampedArray<ArrayBuffer>, w, h));
      } else r.setImage(baseBitmap);
      if (!r.supportsLocal) setNote('This GPU cannot render to float textures: Texture, Clarity and Dehaze are disabled.');
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
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      r.render(renderParams, { showClipping, overlayMask: overlayIndex, view: viewWindow });
      const rb = r.readback(renderParams, 256);
      publishHistogram(computeHistogram(rb.data));
    });
    return () => cancelAnimationFrame(frame.current);
  }, [image, sourceKey, renderParams, showClipping, cssW, cssH, pw, ph, overlayIndex, viewWindow]);

  useEffect(() => { if (!image) publishHistogram(null); }, [image]);

  const geo = useMemo(() => makeGeoMap(params, bw, bh), [params, bw, bh]);

  // ---- zoom controls
  const canvasFraction = (clientX: number, clientY: number): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  };
  const setZoomTo = useCallback((target: number | 'fit') => {
    if (target === 'fit' || target <= zFit * 1.0001) return store.zoomFit();
    const cur = { z: zoom.z, cx: zoom.cx, cy: zoom.cy };
    store.setZoom(zoomAt(cur, target / (cur.z ?? zFit), 0.5, 0.5, native.w, native.h, pw, ph, zFit)); // about the window centre
  }, [zoom, zFit, native.w, native.h, pw, ph]);

  // The Z shortcut asks for a toggle through the store; the viewer knows the fit scale.
  const zoomToggle = useEditor((s) => s.zoomToggle);
  useEffect(() => { if (zoomToggle) setZoomTo(z ? 'fit' : 1); }, [zoomToggle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom around the cursor (non-passive so the page does not scroll).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !zoomAllowed) return;
    const onWheel = (e: WheelEvent) => {
      if (!image || cssW < 2) return;
      e.preventDefault();
      const [au, av] = canvasFraction(e.clientX, e.clientY);
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      store.setZoom(zoomAt({ z: zoom.z, cx: zoom.cx, cy: zoom.cy }, f, Math.min(1, Math.max(0, au)), Math.min(1, Math.max(0, av)), native.w, native.h, pw, ph, zFit));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }); // re-bound each render: it reads the current zoom

  useEffect(() => {
    const isText = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !isText(e.target)) { setSpaceDown(true); if (zoomed) e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [zoomed]);

  // Drag to pan: plain drag in the Edit tool, Space/middle-button drag in the others.
  const panRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!zoomed || !z) return;
    const canPan = (e.button === 0 && ((tool === 'edit' && !eyedropper) || spaceDown)) || e.button === 1;
    if (!canPan) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy };
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p || !z) return;
    const n = panBy(z, p.cx, p.cy, (e.clientX - p.x) * dpr, (e.clientY - p.y) * dpr, native.w, native.h, pw, ph);
    store.setZoom({ z, cx: n.cx, cy: n.cy });
  };
  const onStagePointerUp = () => { panRef.current = null; };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!eyedropper || tool !== 'edit') return;
    const [fx, fy] = canvasFraction(e.clientX, e.clientY);
    const [u, v] = screenToOutput(view, fx, fy);
    store.pickWhiteBalance(u, v);
  };

  const percent = Math.round((z ?? zFit) * 100);
  const panning = zoomed && ((tool === 'edit' && !eyedropper) || spaceDown);

  return (
    <div className="viewer" ref={wrapRef}>
      {error && <div className="viewer-error">{error}</div>}
      <div
        className={`stage${zoomed ? ' zoomed' : ''}`}
        style={{ width: cssW, height: cssH, display: image && !error ? 'block' : 'none', cursor: panning ? (panRef.current ? 'grabbing' : 'grab') : undefined }}
        onPointerDownCapture={onStagePointerDown} onPointerMove={onStagePointerMove} onPointerUp={onStagePointerUp} onPointerCancel={onStagePointerUp}
      >
        <canvas
          ref={canvasRef}
          className={`viewer-canvas${eyedropper && tool === 'edit' ? ' picking' : ''}`}
          style={{ width: cssW, height: cssH }}
          onClick={onClick}
          data-testid="viewer-canvas"
          data-zoom={z ? z.toFixed(3) : 'fit'}
          data-view={`${view.ox.toFixed(4)},${view.oy.toFixed(4)},${view.sx.toFixed(4)},${view.sy.toFixed(4)}`}
          data-source={useFull ? `full ${fullRes!.bitmap.width}x${fullRes!.bitmap.height}` : `preview ${bw}x${bh}`}
        />
        {image && tool === 'crop' && !showOriginal && <CropOverlay width={cssW} height={cssH} />}
        {image && tool === 'retouch' && !showOriginal && <RetouchOverlay width={cssW} height={cssH} geo={geo} view={view} />}
        {image && tool === 'mask' && !showOriginal && <MaskOverlay width={cssW} height={cssH} geo={geo} srcW={bw} srcH={bh} view={view} />}
      </div>
      {image && zoomAllowed && (
        <div className="zoom-bar" role="group" aria-label="Zoom">
          <button className={!z ? 'on' : ''} data-zoom-btn="fit" onClick={() => setZoomTo('fit')} title="Fit to window">Fit</button>
          <button className={z && Math.abs(z - 1) < 0.01 ? 'on' : ''} data-zoom-btn="100" onClick={() => setZoomTo(1)} title="100 % — one image pixel per screen pixel (Z)">100%</button>
          <button className={z && Math.abs(z - 2) < 0.01 ? 'on' : ''} data-zoom-btn="200" onClick={() => setZoomTo(2)} title="200 %">200%</button>
          <span className="zoom-readout" data-testid="zoom-readout">{percent}%</span>
        </div>
      )}
      {showOriginal && image && <div className="badge">Original</div>}
      {loading && <div className="badge busy">Loading…</div>}
      {fullResLoading && <div className="badge busy" data-testid="fullres-loading">Loading full resolution…</div>}
      {z && needFull && !useFull && !fullResLoading && <div className="badge busy">Preview resolution</div>}
      {note && <div className="badge warn">{note}</div>}
    </div>
  );
}
