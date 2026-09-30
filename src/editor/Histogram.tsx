import { useEffect, useRef, useState } from 'react';
import { store, useEditor } from './store';
import { useHistogram } from './histogramStore';

type Mode = 'rgb' | 'r' | 'g' | 'b' | 'luma';

export function Histogram() {
  const h = useHistogram();
  const clipping = useEditor((s) => s.showClipping);
  const [mode, setMode] = useState<Mode>('rgb');
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 1; i < 4; i++) ctx.fillRect((W * i) / 4, 0, 1, H);
    if (!h) return;
    const series: [Uint32Array, string][] =
      mode === 'rgb' ? [[h.r, '#ff4b4b'], [h.g, '#3ddc6a'], [h.b, '#4b7bff']]
      : mode === 'r' ? [[h.r, '#ff4b4b']]
      : mode === 'g' ? [[h.g, '#3ddc6a']]
      : mode === 'b' ? [[h.b, '#4b7bff']]
      : [[h.luma, '#d8d8d8']];
    // Scale to the tallest interior bin so clipped end bins don't flatten the plot.
    let max = 1;
    for (const [d] of series) for (let i = 1; i < 255; i++) max = Math.max(max, d[i]);
    ctx.globalCompositeOperation = mode === 'rgb' ? 'lighter' : 'source-over';
    for (const [d, color] of series) {
      ctx.fillStyle = color + (mode === 'rgb' ? '99' : 'cc');
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, d[i] / max) * (H - 2));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [h, mode]);

  const pct = (x: number) => (x * 100).toFixed(x > 0 && x < 0.001 ? 2 : 1) + '%';
  return (
    <div className="histogram">
      <canvas ref={ref} width={560} height={200} aria-label="Histogram" />
      <div className="histogram-bar">
        <div className="seg" role="group" aria-label="Histogram channel">
          {(['rgb', 'r', 'g', 'b', 'luma'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'luma' ? 'L' : m.toUpperCase()}</button>
          ))}
        </div>
        <button className={`clip-toggle${clipping ? ' on' : ''}`} onClick={store.toggleClipping} title="Show clipped pixels on the image (J)">
          <span className="dot lo" />{h ? pct(h.clipLow) : '–'} <span className="dot hi" />{h ? pct(h.clipHigh) : '–'}
        </button>
      </div>
    </div>
  );
}
