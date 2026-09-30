import { useRef, useState, type PointerEvent } from 'react';
import { dragCrop, presetRatio, type CropHandle } from '../geometry/crop';
import { store, useEditor } from './store';

const HANDLES: { id: CropHandle; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' }, { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' }, { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' }, { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' }, { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' }, { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
];

/**
 * The crop rectangle over the full (rotated) canvas. Dragging only changes four numbers in the
 * edit parameters; it can't leave the picture's valid area (e.g. after Straighten), and with an
 * aspect preset the ratio stays locked.
 */
export function CropOverlay({ width, height }: { width: number; height: number }) {
  const crop = useEditor((s) => s.params.crop);
  const guides = useEditor((s) => s.cropGuides);
  const straighten = useEditor((s) => s.straightenTool);
  const [line, setLine] = useState<[number, number, number, number] | null>(null);
  const drag = useRef<{ handle: CropHandle; x: number; y: number; start: typeof crop } | null>(null);

  const begin = (handle: CropHandle) => (e: PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: store.getState().params.crop };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const ratio = presetRatio(d.start, width / height);
    const next = dragCrop(d.start, d.handle, (e.clientX - d.x) / width, (e.clientY - d.y) / height, ratio, { w: width, h: height });
    if (store.cropValid(next)) store.previewCrop(next); // a drag that would read outside the picture simply stops there
  };
  const end = () => { if (drag.current) { drag.current = null; store.commitCrop(); } };

  // Straighten tool: drag a line along the horizon / an edge
  const local = (e: PointerEvent) => { const r = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const lineDown = (e: PointerEvent) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); const [x, y] = local(e); setLine([x, y, x, y]); };
  const lineMove = (e: PointerEvent) => { if (line) { const [x, y] = local(e); setLine([line[0], line[1], x, y]); } };
  const lineUp = () => { if (line) { const l = line; setLine(null); store.straightenLine(...l); } };

  const x = crop.x * width, y = crop.y * height, w = crop.w * width, h = crop.h * height;
  return (
    <svg className="crop-overlay" width={width} height={height} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <path d={`M0,0H${width}V${height}H0Z M${x},${y}V${y + h}H${x + w}V${y}Z`} fillRule="evenodd" fill="rgba(0,0,0,.6)" />
      {guides !== 'none' && (
        <g stroke="rgba(255,255,255,.35)" strokeWidth="1" pointerEvents="none" data-guides={guides}>
          {Array.from({ length: (guides === 'grid' ? 8 : 3) - 1 }, (_, i) => i + 1).map((i) => { const n = guides === 'grid' ? 8 : 3; return <line key={`v${i}`} x1={x + (w * i) / n} y1={y} x2={x + (w * i) / n} y2={y + h} />; })}
          {Array.from({ length: (guides === 'grid' ? 8 : 3) - 1 }, (_, i) => i + 1).map((i) => { const n = guides === 'grid' ? 8 : 3; return <line key={`h${i}`} x1={x} y1={y + (h * i) / n} x2={x + w} y2={y + (h * i) / n} />; })}
        </g>
      )}
      <rect x={x} y={y} width={w} height={h} fill="transparent" stroke="#fff" strokeWidth="1.5" style={{ cursor: 'move' }} onPointerDown={begin('move')} data-testid="crop-body" />
      {HANDLES.map((hd) => (
        <rect key={hd.id} data-handle={hd.id} x={x + hd.x * w - 6} y={y + hd.y * h - 6} width={12} height={12} fill="#fff" stroke="#000" strokeWidth="1" style={{ cursor: hd.cursor }} onPointerDown={begin(hd.id)} />
      ))}
      {straighten && (
        <g>
          <rect x={0} y={0} width={width} height={height} fill="transparent" style={{ cursor: 'crosshair' }} data-testid="straighten-surface" onPointerDown={lineDown} onPointerMove={lineMove} onPointerUp={lineUp} onPointerCancel={lineUp} />
          {line && <line x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} stroke="#ffb13d" strokeWidth="2" pointerEvents="none" />}
        </g>
      )}
    </svg>
  );
}
