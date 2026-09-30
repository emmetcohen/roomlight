/** Pure list operations on spots (mirrors masks/ops.ts). */
import { MAX_SPOTS, type Spot } from './types';

export const limitReason = (spots: Spot[]): string | null =>
  spots.length >= MAX_SPOTS ? `A photo can have at most ${MAX_SPOTS} retouch spots. Delete or merge some first.` : null;

export const addSpot = (spots: Spot[], s: Spot): Spot[] => [...spots, s];
export const removeSpot = (spots: Spot[], id: string): Spot[] => spots.filter((s) => s.id !== id);
export const updateSpot = (spots: Spot[], id: string, fn: (s: Spot) => Spot): Spot[] => spots.map((s) => (s.id === id ? fn(s) : s));

/** Brush-size slider (1..100) → radius in mask space. */
export const spotRadius = (size: number): number => 0.004 + 0.116 * (size / 100) ** 2;
export const sizeOfRadius = (r: number): number => Math.round(100 * Math.sqrt(Math.max(0, (r - 0.004) / 0.116)));
