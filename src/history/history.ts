/**
 * Snapshot history. Entries are small immutable parameter objects — never pixels — so a
 * thousand steps cost a few hundred KB at most.
 *
 * Gesture model: while a slider is dragged, `preview` updates the *live* state without
 * touching history; `commit` then records one entry for the whole gesture. Rapid commits
 * with the same `coalesceKey` (e.g. arrow-key nudges) merge into a single entry.
 */

export interface HistoryEntry<T> {
  label: string;
  state: T;
  time: number;
  key?: string;
}

export interface History<T> {
  entries: HistoryEntry<T>[];
  index: number;
  /** Uncommitted state from an in-progress gesture, if any. */
  live: T | null;
  liveKey?: string;
}

export const COALESCE_WINDOW_MS = 800;

export function createHistory<T>(initial: T, label = 'Original', now = Date.now()): History<T> {
  return { entries: [{ label, state: initial, time: now }], index: 0, live: null };
}

export function present<T>(h: History<T>): T {
  return h.live ?? h.entries[h.index].state;
}

export function canUndo<T>(h: History<T>): boolean {
  return h.live !== null || h.index > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.live === null && h.index < h.entries.length - 1;
}

/** Update the live state without recording history. */
export function preview<T>(h: History<T>, next: T): History<T> {
  return { ...h, live: next };
}

export function commit<T>(
  h: History<T>,
  label: string,
  equals: (a: T, b: T) => boolean,
  opts: { key?: string; now?: number } = {},
): History<T> {
  if (h.live === null) return h;
  const now = opts.now ?? Date.now();
  const base = h.entries[h.index];
  if (equals(base.state, h.live)) return { ...h, live: null };

  const last = h.entries[h.index];
  const atTip = h.index === h.entries.length - 1;
  if (opts.key && atTip && h.index > 0 && last.key === opts.key && now - last.time < COALESCE_WINDOW_MS) {
    const entries = h.entries.slice(0, h.index);
    entries.push({ label, state: h.live, time: now, key: opts.key });
    return { entries, index: h.index, live: null };
  }
  const entries = h.entries.slice(0, h.index + 1);
  entries.push({ label, state: h.live, time: now, key: opts.key });
  return { entries, index: entries.length - 1, live: null };
}

/** Commit a change in one step (no gesture). */
export function apply<T>(
  h: History<T>,
  next: T,
  label: string,
  equals: (a: T, b: T) => boolean,
  opts: { key?: string; now?: number } = {},
): History<T> {
  return commit(preview(h, next), label, equals, opts);
}

export function undo<T>(h: History<T>): History<T> {
  // Undoing with an uncommitted gesture just discards the gesture.
  if (h.live !== null) return { ...h, live: null };
  return h.index > 0 ? { ...h, index: h.index - 1 } : h;
}

export function redo<T>(h: History<T>): History<T> {
  return canRedo(h) ? { ...h, index: h.index + 1 } : h;
}

export function jumpTo<T>(h: History<T>, index: number): History<T> {
  if (index < 0 || index >= h.entries.length) return h;
  return { ...h, index, live: null };
}
