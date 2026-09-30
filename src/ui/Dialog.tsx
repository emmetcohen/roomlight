import { useEffect, useRef, type ReactNode } from 'react';

/** Modal dialog: Escape or a click on the backdrop closes it; focus moves inside and returns afterwards. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose; // the latest handler, without re-running the focus effect on every render
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header><h2>{title}</h2><button className="icon" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
