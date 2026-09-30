import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CURVE_CHANNELS, addPoint, isIdentityCurve, makeCurve, movePoint, removePoint, type CurveChannel, type CurvePoint } from '../image-engine/curves';
import { store, useEditor } from './store';
import { useHistogram } from './histogramStore';

const SIZE = 256, PAD = 10, VB = SIZE + PAD * 2;
const COLOR: Record<CurveChannel, string> = { rgb: '#e8e8ea', r: '#ff5a5a', g: '#45d96f', b: '#5b8cff' };
const NAME: Record<CurveChannel, string> = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
const HIT = 12; // px

const sx = (x: number) => PAD + x * SIZE;
const sy = (y: number) => PAD + (1 - y) * SIZE;

function pathOf(pts: CurvePoint[]): string {
  const f = makeCurve(pts);
  let d = '';
  for (let i = 0; i <= 128; i++) { const x = i / 128; d += `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(f(x)).toFixed(1)}`; }
  return d;
}

/**
 * Tone-curve editor. Drag points, click the curve to add one, double-click / right-click /
 * Delete to remove, arrow keys to nudge. The first and last points are the black and white
 * points: they can move in both axes but can't be removed.
 */
export function CurveEditor() {
  const curves = useEditor((s) => s.params.curves);
  const hist = useHistogram();
  const [channel, setChannel] = useState<CurveChannel>('rgb');
  const [sel, setSel] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pts = curves[channel];

  const backdrop = useMemo(() => {
    if (!hist) return '';
    const data = channel === 'r' ? hist.r : channel === 'g' ? hist.g : channel === 'b' ? hist.b : hist.luma;
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, data[i]);
    let d = `M${sx(0)},${sy(0)}`;
    for (let i = 0; i < 256; i++) d += `L${sx(i / 255).toFixed(1)},${(sy(0) - Math.min(1, data[i] / max) * SIZE * 0.85).toFixed(1)}`;
    return d + `L${sx(1)},${sy(0)}Z`;
  }, [hist, channel]);

  const toCurve = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = VB / r.width;
    return { x: ((e.clientX - r.left) * k - PAD) / SIZE, y: 1 - ((e.clientY - r.top) * k - PAD) / SIZE, k, r };
  };
  const nearest = (e: { clientX: number; clientY: number }) => {
    const { x, y, r } = toCurve(e);
    const px = r.width / VB; // CSS px per viewBox unit
    let best = -1, bd = HIT;
    pts.forEach((p, i) => { const d = Math.hypot((p.x - x) * SIZE * px, (p.y - y) * SIZE * px); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    svgRef.current!.focus();
    let i = nearest(e);
    if (i < 0) {
      const { x } = toCurve(e);
      const added = addPoint(pts, x, makeCurve(pts)(Math.min(1, Math.max(0, x)))); // pull the curve up/down from where you clicked
      i = added.index;
      if (added.points !== pts) store.previewCurve(channel, added.points);
    }
    setSel(i);
    drag.current = i;
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current === null) return;
    const { x, y } = toCurve(e);
    store.previewCurve(channel, movePoint(store.getState().params.curves[channel], drag.current, x, y));
  };
  const onUp = () => {
    if (drag.current === null) return;
    drag.current = null;
    store.commitCurve(channel);
  };
  const remove = (i: number) => {
    const next = removePoint(pts, i);
    if (next === pts) return;
    store.previewCurve(channel, next);
    store.commitCurve(channel);
    setSel(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (sel === null || sel >= pts.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(sel); return; }
    const step = e.shiftKey ? 0.02 : 0.004;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    store.previewCurve(channel, movePoint(pts, sel, pts[sel].x + m[0], pts[sel].y + m[1]));
    store.commitCurve(channel);
  };

  const s = sel !== null && sel < pts.length ? pts[sel] : null;
  const role = s === null ? '' : sel === 0 ? 'Black point' : sel === pts.length - 1 ? 'White point' : 'Point';

  return (
    <div className="curve-editor">
      <div className="curve-tabs">
        <div className="seg" role="tablist" aria-label="Curve channel">
          {CURVE_CHANNELS.map((c) => (
            <button key={c} role="tab" aria-selected={c === channel} className={c === channel ? 'on' : ''} onClick={() => { setChannel(c); setSel(null); }}>
              <span className="dot" style={{ background: COLOR[c] }} />{NAME[c]}
            </button>
          ))}
        </div>
        <button className="tool" disabled={isIdentityCurve(pts)} onClick={() => store.resetCurve(channel)} title={`Reset ${NAME[channel]} curve`}>Reset</button>
      </div>
      <svg
        ref={svgRef}
        className="curve-svg"
        viewBox={`0 0 ${VB} ${VB}`}
        tabIndex={0}
        role="application"
        aria-label={`${NAME[channel]} tone curve editor`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => { e.preventDefault(); const i = nearest(e); if (i >= 0) remove(i); }}
        onDoubleClick={(e) => { const i = nearest(e); if (i >= 0) remove(i); }}
        onKeyDown={onKey}
      >
        <rect x={PAD} y={PAD} width={SIZE} height={SIZE} fill="#101011" stroke="#2e2e31" />
        {backdrop && <path d={backdrop} fill="#ffffff14" />}
        {[1, 2, 3].map((i) => (<g key={i}><line x1={sx(i / 4)} y1={sy(0)} x2={sx(i / 4)} y2={sy(1)} stroke="#2a2a2d" /><line x1={sx(0)} y1={sy(i / 4)} x2={sx(1)} y2={sy(i / 4)} stroke="#2a2a2d" /></g>))}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#3a3a3e" strokeDasharray="3 3" />
        {CURVE_CHANNELS.filter((c) => c !== channel && !isIdentityCurve(curves[c])).map((c) => (
          <path key={c} d={pathOf(curves[c])} fill="none" stroke={COLOR[c]} strokeOpacity={0.35} strokeWidth={1.2} />
        ))}
        <path d={pathOf(pts)} fill="none" stroke={COLOR[channel]} strokeWidth={1.8} />
        {pts.map((p, i) => {
          const end = i === 0 || i === pts.length - 1;
          const on = i === sel;
          return end
            ? <rect key={i} x={sx(p.x) - 4.5} y={sy(p.y) - 4.5} width={9} height={9} fill={on ? '#f0a93a' : '#141414'} stroke={on ? '#f0a93a' : COLOR[channel]} strokeWidth={1.6} />
            : <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={5} fill={on ? '#f0a93a' : '#141414'} stroke={on ? '#f0a93a' : COLOR[channel]} strokeWidth={1.6} />;
        })}
      </svg>
      <div className="curve-readout">
        {s ? <><b>{role}</b> · In {Math.round(s.x * 255)} → Out {Math.round(s.y * 255)}</> : <span className="muted">Click the curve to add a point · drag to shape · double-click a point to remove · end squares are the black / white points</span>}
      </div>
    </div>
  );
}
