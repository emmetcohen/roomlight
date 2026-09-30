/**
 * Central shortcut table. Bindings are data (`keys`), so a settings UI can rebind them
 * later; the handler only looks keys up here.
 */
import { store } from '../editor/store';

export interface Shortcut {
  id: string;
  label: string;
  /** How the key is shown in the help list (defaults to the first binding). */
  display?: string;
  /** Normalised combos: optional "mod+" (Ctrl/Cmd), "shift+", then a lowercase key. */
  keys: string[];
  run: () => unknown;
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'undo', label: 'Undo', keys: ['mod+z'], run: () => store.undo() },
  { id: 'redo', label: 'Redo', keys: ['mod+shift+z', 'mod+y'], run: () => store.redo() },
  { id: 'before-after', label: 'Toggle before / after', keys: ['\\'], run: () => store.toggleOriginal() },
  { id: 'clipping', label: 'Toggle clipping warnings', keys: ['j'], run: () => store.toggleClipping() },
  { id: 'reset-all', label: 'Reset all edits', keys: ['mod+shift+r'], run: () => store.resetAll() },
  { id: 'zoom', label: 'Zoom: fit ↔ 100 %', keys: ['z'], run: () => store.toggleZoom() },
  { id: 'tool-edit', label: 'Edit tool', keys: ['e'], run: () => store.setTool('edit') },
  { id: 'tool-crop', label: 'Crop tool', keys: ['c'], run: () => store.setTool('crop') },
  { id: 'tool-mask', label: 'Masking tool', keys: ['m'], run: () => store.setTool('mask') },
  { id: 'tool-retouch', label: 'Retouch tool', keys: ['q'], run: () => store.setTool('retouch') },
  { id: 'delete-spot', label: 'Delete selected spot', keys: ['delete', 'backspace'], run: () => { const s = store.getState(); if (s.tool === 'retouch' && s.selectedSpot) store.removeSpot(s.selectedSpot); } },
  { id: 'mask-brush', label: 'New brush mask', keys: ['b'], run: () => store.getState().tool === 'mask' && store.createMask('brush') },
  { id: 'mask-linear', label: 'New linear gradient', keys: ['l'], run: () => store.getState().tool === 'mask' && store.createMask('linear') },
  { id: 'mask-radial', label: 'New radial gradient', keys: ['r'], run: () => store.getState().tool === 'mask' && store.createMask('radial') },
  { id: 'done', label: 'Leave crop / masking / retouch', keys: ['escape'], run: () => store.getState().tool !== 'edit' && store.setTool('edit') },
  { id: 'next', label: 'Next photo', keys: ['arrowright'], run: () => store.step(1) },
  { id: 'prev', label: 'Previous photo', keys: ['arrowleft'], run: () => store.step(-1) },
  { id: 'rate', label: 'Rate (0 clears)', display: '0–5', keys: ['1', '2', '3', '4', '5', '0'], run: () => undefined },
  { id: 'pick', label: 'Pick', keys: ['p'], run: () => store.setFlag('pick') },
  { id: 'reject', label: 'Reject', keys: ['x'], run: () => store.setFlag('reject') },
  { id: 'unflag', label: 'Clear flag', keys: ['u'], run: () => store.setFlag('none', store.targets()) },
  { id: 'label', label: 'Color label', display: '6–9', keys: ['6', '7', '8', '9'], run: () => undefined },
  { id: 'copy-settings', label: 'Copy settings…', keys: ['mod+shift+c'], run: () => store.openDialog('copy') },
  { id: 'paste-settings', label: 'Paste settings…', keys: ['mod+shift+v'], run: () => store.openDialog('paste') },
  { id: 'select-all', label: 'Select all shown photos', keys: ['mod+a'], run: () => store.selectAllVisible() },
  { id: 'export', label: 'Export…', keys: ['mod+shift+e'], run: () => store.openDialog('export') },
];

const LABEL_KEYS: Record<string, 'red' | 'yellow' | 'green' | 'blue'> = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' };

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
    // Menus, dropdowns and text editing keep their own keys; digits on a focused slider are not ratings.
    if (t && (t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (t?.tagName === 'INPUT' && /^[0-9]$/.test(e.key)) return;
    // Arrow keys on a focused slider belong to the slider.
    if (t?.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    const combo = comboOf(e);
    if (store.getState().dialog) return; // dialogs own the keyboard
    if (/^[0-5]$/.test(combo)) { e.preventDefault(); store.setRating(Number(combo)); return; }
    if (combo in LABEL_KEYS) { e.preventDefault(); store.setLabel(LABEL_KEYS[combo]); return; }
    const hit = SHORTCUTS.find((s) => s.keys.includes(combo));
    if (!hit) return;
    e.preventDefault();
    hit.run();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
