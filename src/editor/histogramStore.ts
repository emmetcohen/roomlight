import { useSyncExternalStore } from 'react';
import type { HistogramData } from '../image-engine/histogram';

/** Latest histogram of the *rendered* output, published by the viewer after every render. */
let current: HistogramData | null = null;
const listeners = new Set<() => void>();

export function publishHistogram(h: HistogramData | null) {
  current = h;
  for (const l of listeners) l();
}

export function useHistogram(): HistogramData | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
  );
}
