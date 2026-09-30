import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PARAMS } from '../image-engine/params';
import { computeHistogram } from '../image-engine/histogram';
import { WebGLRenderer } from '../image-engine/webglRenderer';
import { publishHistogram } from './histogramStore';
import { store, useEditor } from './store';

/**
 * Canvas viewer. Owns the WebGL renderer; on any change to (image, params, view flags)
 * it re-renders original + parameters and publishes a histogram of the rendered output.
 */
export function Viewer() {
  const image = useEditor((s) => s.image);
  const params = useEditor((s) => s.params);
  const showOriginal = useEditor((s) => s.showOriginal);
  const showClipping = useEditor((s) => s.showClipping);
  const eyedropper = useEditor((s) => s.eyedropper);
  const loading = useEditor((s) => s.loading);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit the image inside the available box (CSS pixels).
  const pad = 24;
  const aw = Math.max(0, box.w - pad * 2), ah = Math.max(0, box.h - pad * 2);
  const ar = image ? image.bitmap.width / image.bitmap.height : 1;
  const cssW = Math.floor(Math.min(aw, ah * ar));
  const cssH = Math.floor(cssW / ar);

  // Upload the original whenever the photo changes (renderer is created lazily, once).
  useEffect(() => {
    if (!image) return;
    try {
      rendererRef.current ??= new WebGLRenderer(canvasRef.current!);
      rendererRef.current.setImage(image.bitmap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [image]);

  useEffect(() => () => { rendererRef.current?.dispose(); rendererRef.current = null; }, []);

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
      const p = showOriginal ? DEFAULT_PARAMS : params; // the original is always one flag away
      r.render(p, { showClipping });
      const rb = r.readback(p, 256);
      publishHistogram(computeHistogram(rb.data));
    });
    return () => cancelAnimationFrame(frame.current);
  }, [image, params, showOriginal, showClipping, cssW, cssH]);

  useEffect(() => { if (!image) publishHistogram(null); }, [image]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!eyedropper) return;
    const rect = e.currentTarget.getBoundingClientRect();
    store.pickWhiteBalance((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };

  return (
    <div className="viewer" ref={wrapRef}>
      {error && <div className="viewer-error">{error}</div>}
      <canvas
        ref={canvasRef}
        className={`viewer-canvas${eyedropper ? ' picking' : ''}`}
        style={{ width: cssW, height: cssH, display: image && !error ? 'block' : 'none' }}
        onClick={onClick}
        data-testid="viewer-canvas"
      />
      {showOriginal && image && <div className="badge">Original</div>}
      {loading && <div className="badge busy">Loading…</div>}
    </div>
  );
}
