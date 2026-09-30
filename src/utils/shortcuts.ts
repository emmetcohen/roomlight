/**
 * Central shortcut table. Bindings are data (`keys`), so a settings UI can rebind them
 * later; the handler only looks keys up here.
 */
import { store } from '../editor/store';

export interface Shortcut {
  id: string;
  label: string;
  /** Normalised combos: optional "mod+" (Ctrl/Cmd), "shift+", then a lowercase key. */
  keys: string[];
  run: () => void;
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'undo', label: 'Undo', keys: ['mod+z'], run: () => store.undo() },
  { id: 'redo', label: 'Redo', keys: ['mod+shift+z', 'mod+y'], run: () => store.redo() },
  { id: 'before-after', label: 'Toggle before / after', keys: ['\\'], run: () => store.toggleOriginal() },
  { id: 'clipping', label: 'Toggle clipping warnings', keys: ['j'], run: () => store.toggleClipping() },
  { id: 'reset-all', label: 'Reset all edits', keys: ['mod+shift+r'], run: () => store.resetAll() },
  { id: 'next', label: 'Next photo', keys: ['arrowright'], run: () => step(1) },
  { id: 'prev', label: 'Previous photo', keys: ['arrowleft'], run: () => step(-1) },
];

function step(d: number) {
  const { photos, currentId } = store.getState();
  const i = photos.findIndex((p) => p.id === currentId);
  const next = photos[i + d];
  if (next) void store.select(next.id);
}

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.shiftKey && (e.ctrlKey || e.metaKey)) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' || t.tagName === 'TEXTAREA');
    if (typing) return;
    // Arrow keys on a focused slider belong to the slider.
    if (t?.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    const combo = comboOf(e);
    const hit = SHORTCUTS.find((s) => s.keys.includes(combo));
    if (!hit) return;
    e.preventDefault();
    hit.run();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
