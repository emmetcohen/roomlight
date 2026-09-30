import { useEffect, useState } from 'react';

/**
 * A number box that lets you type freely (no clamping while typing) and commits a valid value on
 * Enter or blur; an invalid entry snaps back to the last good value.
 */
export function NumberField({ value, onCommit, min, max, label, className = 'text num wide-num' }: { value: number; onCommit: (v: number) => void; min: number; max: number; label: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const n = Math.round(parseFloat(draft));
    setDraft(null);
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
  };
  return (
    <input
      className={className} aria-label={label} inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); } e.stopPropagation(); }}
    />
  );
}
