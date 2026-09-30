import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { SLIDER_BY_KEY, formatParam, type ParamKey } from '../image-engine/params';
import { store, useEditor } from '../editor/store';

/**
 * A slider bound to one edit parameter. Everything it shows and does comes from the
 * slider registry (range, default, step) and the editor store (value, history).
 *  - drag / arrow keys preview live; release / key nudge records a history entry
 *  - double-click or ↺ resets; Shift+arrow moves 10× faster
 *  - the number box accepts typed values
 */
export function Slider({ param }: { param: ParamKey }) {
  const def = SLIDER_BY_KEY[param];
  const value = useEditor((s) => s.params[param]);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);

  const span = def.max - def.min;
  const pct = ((value - def.min) / span) * 100;
  const pctDefault = ((def.default - def.min) / span) * 100;
  const style = {
    '--fill-from': `${Math.min(pct, pctDefault)}%`,
    '--fill-to': `${Math.max(pct, pctDefault)}%`,
    ...(def.track ? { '--track': `linear-gradient(90deg, ${def.track})` } : {}),
  } as CSSProperties;

  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = def.step * (e.shiftKey ? 10 : 1);
    const next = Math.round((value + dir * step) / def.step) * def.step;
    store.setParam(param, Number(next.toFixed(6)), true);
  };

  const commitDraft = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) store.setParam(param, n);
    setDraft(null);
  };

  const edited = value !== def.default;

  return (
    <div className={`slider${def.track ? ' has-track' : ''}${edited ? ' edited' : ''}`} style={style} data-param={param}>
      <label className="slider-label" onDoubleClick={() => store.resetParam(param)} title="Double-click to reset">
        {def.label}
      </label>
      <input
        className="slider-number"
        aria-label={`${def.fullLabel} value`}
        value={draft ?? formatParam(param, value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); e.stopPropagation(); }}
        onFocus={(e) => e.target.select()}
      />
      <button className="slider-reset" disabled={!edited} onClick={() => store.resetParam(param)} aria-label={`Reset ${def.fullLabel}`} title="Reset">↺</button>
      <input
        className="slider-range"
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        aria-label={def.fullLabel}
        onChange={(e) => store.previewParam(param, parseFloat(e.target.value))}
        onPointerUp={() => store.commitParam(param)}
        onPointerCancel={() => store.commitParam(param)}
        onKeyDown={onKey}
        onDoubleClick={() => store.resetParam(param)}
      />
    </div>
  );
}
