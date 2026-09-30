import { useRef, type PointerEvent, type ReactNode } from 'react';
import { maskToOutput, outputToMask, type GeoMap } from '../geometry/transform';
import { clampRadius, type Spot } from '../retouch/types';
import { IDENTITY_VIEW, type ViewRect } from './viewMath';
import { store, useEditor } from './store';

const COLOR: Record<Spot['kind'], string> = { clone: '#6cc3ff', heal: '#ffffff', remove: '#ffb13d' };

/**
 * Spot markers drawn over the picture: a circle on the target, a dashed circle on the source
 * and a line between them. Click empty space to add a spot; drag a circle to move it, drag the
 * small handle on the edge to resize. Everything goes through the geometry transform, so the
 * markers stay on the right content under crop / rotate / perspective.
 */
export function RetouchOverlay({ width, height, geo, view = IDENTITY_VIEW }: { width: number; height: number; geo: GeoMap; view?: ViewRect }) {
  const spots = useEditor((s) => s.params.spots);
  const selected = useEditor((s) => s.selectedSpot);
  const showOverlay = useEditor((s) => s.showOverlay);
  const svgRef = useRef<SVGSVGElement>(null);
  const sources = store.spotSources();

  const pxPerMask = (width / (geo.crop.w * geo.canvas.w)) * geo.L / view.sx;
  const toScreen = (mx: number, my: number): [number, number] | null => {
    const o = maskToOutput(geo, mx, my);
    return o ? [((o[0] - view.ox) / view.sx) * width, ((o[1] - view.oy) / view.sy) * height] : null;
  };
  const toMask = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const r = svgRef.current!.getBoundingClientRect();
    return outputToMask(geo, view.ox + ((e.clientX - r.left) / width) * view.sx, view.oy + ((e.clientY - r.top) / height) * view.sy);
  };

  const drag = (label: string, onMove: (m: [number, number], start: [number, number]) => void) => (e: PointerEvent) => {
    e.stopPropagation();
    const start = toMask(e);
    if (!start) return;
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => { const m = toMask(ev); if (m) onMove(m, start); };
    const up = () => { el.removeEventListener('pointermove', move as EventListener); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); store.commitSpot(label); };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onBackground = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    const m = toMask(e);
    if (m) store.addSpotAt(m[0], m[1]);
  };

  const marks: ReactNode[] = [];
  if (showOverlay) for (const s of spots) {
    const t = toScreen(s.x, s.y);
    if (!t) continue;
    const src = sources.get(s.id);
    const sp = s.kind === 'remove' ? (src?.ok ? toScreen(src.sx, src.sy) : null) : toScreen(s.sx, s.sy);
    const r = Math.max(4, clampRadius(s.r) * pxPerMask);
    const sel = s.id === selected;
    const col = s.enabled ? COLOR[s.kind] : '#888';
    marks.push(
      <g key={s.id} data-spot={s.id} data-kind={s.kind} className={sel ? 'spot sel' : 'spot'} opacity={s.enabled ? 1 : 0.6}>
        {sp && <line x1={t[0]} y1={t[1]} x2={sp[0]} y2={sp[1]} stroke={col} strokeOpacity={0.6} strokeWidth="1.2" strokeDasharray="4 4" pointerEvents="none" />}
        {sp && (
          <circle cx={sp[0]} cy={sp[1]} r={r} fill="rgba(0,0,0,.08)" stroke={col} strokeWidth={sel ? 2 : 1.3} strokeDasharray="6 4" data-handle="source" style={{ cursor: 'move', pointerEvents: 'all' }}
            onPointerDown={(e) => {
              store.selectSpot(s.id);
              drag('Move Spot Source', (m) => store.previewSpot(s.id, (x) => ({ ...x, kind: x.kind === 'remove' ? 'heal' : x.kind, sx: m[0], sy: m[1] })))(e);
            }}><title>Source — drag to choose where pixels are copied from</title></circle>
        )}
        <circle cx={t[0]} cy={t[1]} r={r} fill="rgba(255,255,255,.04)" stroke="#000" strokeOpacity={0.5} strokeWidth={(sel ? 2 : 1.3) + 1.5} pointerEvents="none" />
        <circle cx={t[0]} cy={t[1]} r={r} fill="rgba(255,255,255,.03)" stroke={col} strokeWidth={sel ? 2 : 1.3} data-handle="target" style={{ cursor: 'move', pointerEvents: 'all' }}
          onPointerDown={(e) => {
            store.selectSpot(s.id);
            const s0 = s, off = [s0.sx - s0.x, s0.sy - s0.y];
            drag('Move Spot', (m, st) => store.previewSpot(s.id, (x) => ({ ...x, x: s0.x + m[0] - st[0], y: s0.y + m[1] - st[1], sx: x.kind === 'remove' ? x.sx : s0.x + m[0] - st[0] + off[0], sy: x.kind === 'remove' ? x.sy : s0.y + m[1] - st[1] + off[1] })))(e);
          }}><title>{`${s.kind[0].toUpperCase()}${s.kind.slice(1)} spot — drag to move`}</title></circle>
        {sel && (
          <circle cx={t[0] + r} cy={t[1]} r={5} fill="#fff" stroke="#000" strokeWidth="1.5" data-handle="size" style={{ cursor: 'ew-resize', pointerEvents: 'all' }}
            onPointerDown={drag('Resize Spot', (m) => store.previewSpot(s.id, (x) => ({ ...x, r: clampRadius(Math.hypot(m[0] - x.x, m[1] - x.y)) })))}><title>Size</title></circle>
        )}
      </g>,
    );
  }

  return (
    <svg ref={svgRef} className="mask-overlay" data-testid="retouch-overlay" width={width} height={height} style={{ pointerEvents: 'all', cursor: 'crosshair' }}>
      <rect x={0} y={0} width={width} height={height} fill="transparent" onPointerDown={onBackground} />
      {marks}
    </svg>
  );
}
