import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { SLIDER_BY_KEY, formatParam, type ParamKey } from '../image-engine/params';
import { store, useEditor } from '../editor/store';

/** Everything a slider needs, independent of WHAT it edits (a global parameter, a mask's local adjustment, a shape property...). */
export interface SliderBinding {
  label: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  decimals?: number;
  signed?: boolean;
  track?: string;
  /** Live update while dragging / typing (not recorded). */
  onPreview(v: number): void;
  /** Record the gesture as one history entry. */
  onCommit(): void;
  /** One-shot change (keyboard nudge, typed value); `coalesce` merges rapid repeats. */
  onSet(v: number, coalesce?: boolean): void;
  onReset(): void;
}

const fmt = (v: number, decimals: number, signed: boolean) => { const f = v.toFixed(decimals); return signed && v > 0 ? `+${f}` : f; };

/**
 * Professional slider:
 *  - drag / arrow keys preview live; release commits one history entry
 *  - double-click the label or track (or ↺) resets; Shift+arrow moves 10× faster
 *  - the number box accepts typed values
 */
export function SliderView(b: SliderBinding) {
  const decimals = b.decimals ?? 0, signed = b.signed ?? b.min < 0;
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [b.value]);

  const span = b.max - b.min;
  const pct = ((b.value - b.min) / span) * 100;
  const pctDefault = ((b.defaultValue - b.min) / span) * 100;
  const style = {
    '--fill-from': `${Math.min(pct, pctDefault)}%`,
    '--fill-to': `${Math.max(pct, pctDefault)}%`,
    ...(b.track ? { '--track': `linear-gradient(90deg, ${b.track})` } : {}),
  } as CSSProperties;

  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = b.step * (e.shiftKey ? 10 : 1);
    const next = Math.round((b.value + dir * step) / b.step) * b.step;
    b.onSet(Math.min(b.max, Math.max(b.min, Number(next.toFixed(6)))), true);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) b.onSet(Math.min(b.max, Math.max(b.min, n)));
    setDraft(null);
  };
  const edited = b.value !== b.defaultValue;
  const name = b.ariaLabel ?? b.label;

  return (
    <div className={`slider${b.track ? ' has-track' : ''}${edited ? ' edited' : ''}`} style={style}>
      <label className="slider-label" onDoubleClick={b.onReset} title="Double-click to reset">{b.label}</label>
      <input
        className="slider-number"
        aria-label={`${name} value`}
        value={draft ?? fmt(b.value, decimals, signed)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); e.stopPropagation(); }}
        onFocus={(e) => e.target.select()}
      />
      <button className="slider-reset" disabled={!edited} onClick={b.onReset} aria-label={`Reset ${name}`} title="Reset">↺</button>
      <input
        className="slider-range"
        type="range"
        min={b.min}
        max={b.max}
        step={b.step}
        value={b.value}
        aria-label={name}
        onChange={(e) => b.onPreview(parseFloat(e.target.value))}
        onPointerDown={() => {
          // hide the mask overlay for the whole gesture; release is caught on the window because a range input can swallow its own pointerup
          store.setOverlaySuppressed(true);
          const end = () => { window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true); store.setOverlaySuppressed(false); };
          window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', end, true);
        }}
        onPointerUp={b.onCommit}
        onPointerCancel={b.onCommit}
        onKeyDown={onKey}
        onDoubleClick={b.onReset}
      />
    </div>
  );
}

/** A slider bound to one global edit parameter. Range, default, step and colour cues come from the slider registry. */
export function Slider({ param }: { param: ParamKey }) {
  const def = SLIDER_BY_KEY[param];
  const value = useEditor((s) => s.params[param]);
  return (
    <div data-param={param}>
      <SliderView
        label={def.label}
        ariaLabel={def.fullLabel}
        value={value}
        min={def.min}
        max={def.max}
        step={def.step}
        defaultValue={def.default}
        decimals={def.decimals}
        signed={def.signed}
        track={def.track}
        onPreview={(v) => store.previewParam(param, v)}
        onCommit={() => store.commitParam(param)}
        onSet={(v, c) => store.setParam(param, v, c)}
        onReset={() => store.resetParam(param)}
      />
    </div>
  );
}

export { formatParam };
