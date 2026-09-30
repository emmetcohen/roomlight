import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const CloseCtx = createContext<() => void>(() => undefined);

/** A button that opens a small popup menu. Closes on a choice, an outside click or Escape. */
export function Menu({ label, children, className = 'tool', ariaLabel, testId, title, align = 'left' }: { label: ReactNode; children: ReactNode; className?: string; ariaLabel?: string; testId?: string; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={className} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} data-testid={testId} title={title} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className={`menu ${align}`} role="menu"><CloseCtx.Provider value={() => setOpen(false)}>{children}</CloseCtx.Provider></div>}
    </div>
  );
}

export function MenuItem({ children, onClick, disabled, title, hint, ...data }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; hint?: string; [k: `data-${string}`]: string | undefined }) {
  const close = useContext(CloseCtx);
  return (
    <button role="menuitem" className="menu-item" disabled={disabled} title={title} {...data} onClick={() => { close(); onClick?.(); }}>
      <span>{children}</span>{hint && <kbd>{hint}</kbd>}
    </button>
  );
}
export const MenuSeparator = () => <div className="menu-sep" role="separator" />;
