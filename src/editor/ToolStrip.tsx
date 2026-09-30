import type { ReactNode } from 'react';
import { store, useEditor, type Tool } from './store';

const I = (children: ReactNode) => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>;

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'presets', label: 'Presets', key: 'V', icon: I(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>) },
  { id: 'edit', label: 'Edit', key: 'E', icon: I(<><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>) },
  { id: 'crop', label: 'Crop & Geometry', key: 'C', icon: I(<><path d="M7 3v14h14M3 7h14v14" /></>) },
  { id: 'retouch', label: 'Healing / Remove', key: 'Q', icon: I(<><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-35 12 12)" /><path d="M10.5 10.5v.01M13.5 13.5v.01M10.5 13.5v.01M13.5 10.5v.01" /></>) },
  { id: 'mask', label: 'Masking', key: 'M', icon: I(<><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="2.5 2.5" /><circle cx="12" cy="12" r="5" /></>) },
];

/** The thin vertical strip of tools on the far right edge. One tool is active at a time; Edit returns to the normal panels. */
export function ToolStrip() {
  const tool = useEditor((s) => s.tool);
  const hasPhoto = useEditor((s) => !!s.currentId);
  return (
    <nav className="tool-strip" role="tablist" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button key={t.id} role="tab" aria-selected={tool === t.id} aria-label={t.label} data-tool={t.id} className={tool === t.id ? 'on' : ''} disabled={!hasPhoto} title={`${t.label} (${t.key})`} onClick={() => store.setTool(t.id)}>
          {t.icon}
        </button>
      ))}
    </nav>
  );
}
