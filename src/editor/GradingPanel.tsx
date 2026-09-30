import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { oklchToCss, oklchToRgb8 } from '../color/oklchCss';
import { GRADE_LABEL, GRADE_RANGES, type GradeRange, type ParamKey } from '../image-engine/params';
import { Slider } from '../ui/Slider';
import { store, useEditor } from './store';

const SIZE = 168;
let wheelCache: HTMLCanvasElement | null = null;

/** The wheel shows the exact colours the grade adds (OKLCH, L = 0.72, chroma ramps to the rim). */
function wheelImage(): HTMLCanvasElement {
  if (wheelCache) return wheelCache;
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = Math.round(SIZE * dpr);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const R = c.width / 2;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R;
    const r = Math.hypot(dx, dy) / R;
    const o = (y * c.width + x) * 4;
    if (r > 1) continue;
    const [cr, cg, cb] = oklchToRgb8(0.72, 0.13 * r, (Math.atan2(-dy, dx) * 180) / Math.PI);
    img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb;
    img.data[o + 3] = Math.min(255, (1 - r) * R * 2 * 255); // soft anti-aliased rim
  }
  ctx.putImageData(img, 0, 0);
  return (wheelCache = c);
}

function Wheel({ range }: { range: GradeRange }) {
  const hue = useEditor((s) => s.params[`grade_${range}_hue` as ParamKey]);
  const sat = useEditor((s) => s.params[`grade_${range}_sat` as ParamKey]);
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(SIZE * dpr);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(wheelImage(), 0, 0, c.width, c.height);
    const R = c.width / 2;
    const a = (hue * Math.PI) / 180, d = (sat / 100) * R;
    const x = R + Math.cos(a) * d, y = R - Math.sin(a) * d;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.arc(R, R, 2.5 * dpr, 0, 7); ctx.stroke(); // centre = no tint
    ctx.strokeStyle = '#fff'; ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.arc(x, y, 6 * dpr, 0, 7); ctx.fill(); ctx.stroke();
  }, [hue, sat]);

  const set = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    const rad = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    const h = (((Math.atan2(-dy, dx) * 180) / Math.PI) + 360) % 360;
    store.previewPatch({ [`grade_${range}_hue`]: Math.round(h) % 360, [`grade_${range}_sat`]: Math.round(rad * 100) });
  };
  const keys = [`grade_${range}_hue`, `grade_${range}_sat`] as ParamKey[];
  return (
    <canvas
      ref={ref}
      className="wheel"
      style={{ width: SIZE, height: SIZE }}
      aria-label={`${GRADE_LABEL[range]} colour wheel`}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); set(e); }}
      onPointerMove={(e) => dragging.current && set(e)}
      onPointerUp={() => { if (dragging.current) { dragging.current = false; store.commitPatch(`${GRADE_LABEL[range]} Color`); } }}
      onPointerCancel={() => { dragging.current = false; store.commitPatch(`${GRADE_LABEL[range]} Color`); }}
      onDoubleClick={() => store.resetKeys(keys, `Reset ${GRADE_LABEL[range]} Color`)}
      title="Drag to pick a hue (angle) and amount (distance). Double-click to reset."
    />
  );
}

/** Shadows / midtones / highlights / global, each with an interactive colour wheel + luminance. */
export function GradingPanel() {
  const [range, setRange] = useState<GradeRange>('shadows');
  const params = useEditor((s) => s.params);
  return (
    <div>
      <div className="seg wide" role="tablist" aria-label="Grading range">
        {GRADE_RANGES.map((r) => {
          const sat = params[`grade_${r}_sat` as ParamKey], hue = params[`grade_${r}_hue` as ParamKey], lum = params[`grade_${r}_lum` as ParamKey];
          return (
            <button key={r} role="tab" aria-selected={r === range} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>
              <span className="dot" style={{ background: sat > 0 ? oklchToCss(0.72, 0.13 * (sat / 100), hue) : lum !== 0 ? '#888' : '#3a3a3e' }} />
              {GRADE_LABEL[r]}
            </button>
          );
        })}
      </div>
      <div className="wheel-wrap"><Wheel range={range} /></div>
      <Slider param={`grade_${range}_hue` as ParamKey} />
      <Slider param={`grade_${range}_sat` as ParamKey} />
      <Slider param={`grade_${range}_lum` as ParamKey} />
      <div className="subhead">Blend</div>
      <Slider param="gradeBlending" />
      <Slider param="gradeBalance" />
    </div>
  );
}
