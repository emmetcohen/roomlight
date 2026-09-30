import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { maskToOutput, outputToMask, type GeoMap } from '../geometry/transform';
import type { Shape } from '../masks/types';
import { brushRadius, store, useEditor } from './store';
import { IDENTITY_VIEW, type ViewRect } from './viewMath';

type Linear = Extract<Shape, { type: 'linear' }>;
type Radial = Extract<Shape, { type: 'radial' }>;

/**
 * Interactive handles for the selected mask component, drawn over the picture.
 * Everything goes through the geometry transform, so handles stay on the right image content
 * under crop / rotate / perspective, and edits are stored in image-attached mask space.
 */
export function MaskOverlay({ width, height, geo, srcW, srcH, view = IDENTITY_VIEW }: { width: number; height: number; geo: GeoMap; srcW: number; srcH: number; view?: ViewRect }) {
  const masks = useEditor((s) => s.params.masks);
  const selMask = useEditor((s) => s.selectedMask);
  const selComp = useEditor((s) => s.selectedComp);
  const brush = useEditor((s) => s.brush);
  const pickingColor = useEditor((s) => s.pickingColor);
  const svgRef = useRef<SVGSVGElement>(null);
  const painting = useRef(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const mask = masks.find((m) => m.id === selMask);
  const comp = mask?.components.find((c) => c.id === selComp);
  const shape = comp?.shape;
  void srcW; void srcH;

  const toScreen = (mx: number, my: number): [number, number] | null => {
    const o = maskToOutput(geo, mx, my);
    return o ? [((o[0] - view.ox) / view.sx) * width, ((o[1] - view.oy) / view.sy) * height] : null;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  const toMask = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const [x, y] = local(e);
    return outputToMask(geo, view.ox + (x / width) * view.sx, view.oy + (y / height) * view.sy);
  };
  /** Screen pixels per mask-space unit (for sizing the brush cursor). */
  const pxPerMask = ((width / (geo.crop.w * geo.canvas.w)) * geo.L) / view.sx;

  if (!mask || !comp || !shape) return <svg ref={svgRef} className="mask-overlay" width={width} height={height} style={{ pointerEvents: 'none' }} />;

  const update = (fn: (s: Shape) => Shape) => store.previewShape(mask.id, comp.id, fn);
  const commit = (label: string) => store.commitShape(label);

  /** Generic drag: calls `onMove` with mask-space coordinates, commits on release. */
  const drag = (label: string, onMove: (m: [number, number], start: [number, number]) => void) => (e: PointerEvent) => {
    e.stopPropagation();
    const start = toMask(e);
    if (!start) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    store.setOverlayHold(true); // show the red overlay while a handle is being dragged
    const el = e.currentTarget as Element;
    const move = (ev: globalThis.PointerEvent) => { const m = toMask(ev); if (m) onMove(m, start); };
    const up = () => { el.removeEventListener('pointermove', move as EventListener); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); store.setOverlayHold(false); commit(label); };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const handle = (key: string, p: [number, number] | null, onDown: (e: PointerEvent) => void, opts: { filled?: boolean; cursor?: string; r?: number; title?: string } = {}): ReactNode =>
    p && (
      <circle key={key} data-handle={key} cx={p[0]} cy={p[1]} r={opts.r ?? 7} fill={opts.filled === false ? 'rgba(0,0,0,.45)' : '#fff'} stroke="#000" strokeWidth="1.5"
        style={{ cursor: opts.cursor ?? 'grab', pointerEvents: 'all' }} onPointerDown={onDown}><title>{opts.title}</title></circle>
    );

  let body: ReactNode = null;

  if (shape.type === 'linear') {
    const a = toScreen(shape.x1, shape.y1), b = toScreen(shape.x2, shape.y2);
    if (a && b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, reach = Math.max(width, height);
      const edge = (p: [number, number], dash?: string) => <line x1={p[0] - nx * reach} y1={p[1] - ny * reach} x2={p[0] + nx * reach} y2={p[1] + ny * reach} stroke="#fff" strokeOpacity={0.75} strokeWidth="1.2" strokeDasharray={dash} pointerEvents="none" />;
      body = (
        <>
          {edge(a)}{edge(b, '5 4')}
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth="1.5" pointerEvents="none" />
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="transparent" strokeWidth="14" style={{ cursor: 'move', pointerEvents: 'stroke' }}
            onPointerDown={(e) => { const s0 = shape as Linear; drag('Move Linear Gradient', (m, st) => update((s) => ({ ...(s as Linear), x1: s0.x1 + m[0] - st[0], y1: s0.y1 + m[1] - st[1], x2: s0.x2 + m[0] - st[0], y2: s0.y2 + m[1] - st[1] })))(e); }} />
          {handle('start', a, drag('Adjust Linear Gradient', (m) => update((s) => ({ ...(s as Linear), x1: m[0], y1: m[1] }))), { title: 'Start: full effect' })}
          {handle('end', b, drag('Adjust Linear Gradient', (m) => update((s) => ({ ...(s as Linear), x2: m[0], y2: m[1] }))), { filled: false, title: 'End: no effect' })}
        </>
      );
    }
  } else if (shape.type === 'radial') {
    const rot = (shape.rotation * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
    const at = (u: number, v: number) => toScreen(shape.cx + cs * u - sn * v, shape.cy + sn * u + cs * v);
    const ring = (k: number) => Array.from({ length: 73 }, (_, i) => { const t = (i / 72) * Math.PI * 2; return at(shape.rx * k * Math.cos(t), shape.ry * k * Math.sin(t)); });
    const path = (pts: ([number, number] | null)[]) => pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p![0].toFixed(1)},${p![1].toFixed(1)}`).join('') + 'Z';
    const c = toScreen(shape.cx, shape.cy);
    const e = at(shape.rx, 0), wst = at(-shape.rx, 0), s = at(0, shape.ry), n = at(0, -shape.ry), knob = at(shape.rx + 40 / pxPerMask, 0);
    const setRx = (m: [number, number]) => update((sh) => ({ ...(sh as Radial), rx: Math.max(0.005, Math.abs((m[0] - shape.cx) * cs + (m[1] - shape.cy) * sn)) }));
    const setRy = (m: [number, number]) => update((sh) => ({ ...(sh as Radial), ry: Math.max(0.005, Math.abs(-(m[0] - shape.cx) * sn + (m[1] - shape.cy) * cs)) }));
    body = (
      <>
        <path d={path(ring(1))} fill="none" stroke="#fff" strokeWidth="1.5" pointerEvents="none" />
        <path d={path(ring(Math.max(0.05, 1 - shape.feather / 100)))} fill="none" stroke="#fff" strokeOpacity={0.6} strokeDasharray="5 4" pointerEvents="none" />
        {c && e && <line x1={c[0]} y1={c[1]} x2={e[0]} y2={e[1]} stroke="#fff" strokeOpacity={0.4} pointerEvents="none" />}
        {handle('center', c, (ev) => { const s0 = shape as Radial; drag('Move Radial Gradient', (m, st) => update((sh) => ({ ...(sh as Radial), cx: s0.cx + m[0] - st[0], cy: s0.cy + m[1] - st[1] })))(ev); }, { cursor: 'move', title: 'Move' })}
        {handle('e', e, drag('Resize Radial Gradient', setRx), { cursor: 'ew-resize', r: 5, title: 'Width' })}
        {handle('w', wst, drag('Resize Radial Gradient', setRx), { cursor: 'ew-resize', r: 5, title: 'Width' })}
        {handle('s', s, drag('Resize Radial Gradient', setRy), { cursor: 'ns-resize', r: 5, title: 'Height' })}
        {handle('n', n, drag('Resize Radial Gradient', setRy), { cursor: 'ns-resize', r: 5, title: 'Height' })}
        {handle('rotate', knob, drag('Rotate Radial Gradient', (m) => update((sh) => ({ ...(sh as Radial), rotation: Math.round((Math.atan2(m[1] - shape.cy, m[0] - shape.cx) * 180) / Math.PI * 10) / 10 }))), { filled: false, cursor: 'alias', r: 6, title: 'Rotate' })}
      </>
    );
  }

  // --- brush painting and colour picking use the whole surface
  const surface = shape.type === 'brush' || (shape.type === 'color' && pickingColor);
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const m = toMask(e);
    if (!m) return;
    if (shape.type === 'brush') {
      e.currentTarget.setPointerCapture(e.pointerId);
      painting.current = true;
      store.setOverlayHold(true);
      store.beginStroke(m[0], m[1], e.pointerType === 'pen' ? e.pressure || 0.5 : 1);
    } else if (shape.type === 'color' && pickingColor) {
      const [x, y] = local(e);
      store.pickMaskColor(view.ox + (x / width) * view.sx, view.oy + (y / height) * view.sy);
    }
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const [x, y] = local(e);
    setHover({ x, y });
    if (!painting.current) return;
    const native = e.nativeEvent as globalThis.PointerEvent;
    const events = native.getCoalescedEvents?.() ?? [native];
    for (const ev of events.length ? events : [native]) {
      const m = toMask(ev);
      if (m) store.extendStroke(m[0], m[1], ev.pointerType === 'pen' ? ev.pressure || 0.5 : 1);
    }
  };
  const onUp = () => { if (painting.current) { painting.current = false; store.setOverlayHold(false); store.endStroke(); } };

  return (
    <svg
      ref={svgRef}
      className="mask-overlay"
      data-testid="mask-overlay"
      width={width}
      height={height}
      style={{ pointerEvents: surface ? 'all' : 'none', cursor: shape.type === 'brush' ? 'none' : pickingColor ? 'crosshair' : 'default' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHover(null)}
    >
      {body}
      {shape.type === 'brush' && hover && (
        <circle cx={hover.x} cy={hover.y} r={Math.max(2, brushRadius(brush.size) * pxPerMask)} fill="none" stroke={brush.erase ? '#ff7a7a' : '#fff'} strokeWidth="1.5" pointerEvents="none" />
      )}
    </svg>
  );
}
