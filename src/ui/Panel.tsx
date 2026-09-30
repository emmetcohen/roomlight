import { useState, type ReactNode } from 'react';

export function Panel({ title, children, onReset, resetDisabled, defaultOpen = true }: { title: string; children: ReactNode; onReset?: () => void; resetDisabled?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel">
      <header className="panel-head">
        <button className="panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`chev${open ? ' open' : ''}`}>▸</span>
          {title}
        </button>
        {onReset && (
          <button className="panel-reset" onClick={onReset} disabled={resetDisabled} title={`Reset ${title}`} aria-label={`Reset ${title}`}>↺</button>
        )}
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}
