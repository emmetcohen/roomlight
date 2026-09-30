/**
 * Retouch spots (Phase 5). A spot replaces the pixels inside a circle with pixels taken from
 * somewhere else in the same picture:
 *
 *   clone   copy the source circle as it is
 *   heal    copy the source circle's texture, then correct its colour and brightness so its
 *           edge matches the surroundings of the target (seamless-cloning style blend)
 *   remove  heal, with the source chosen automatically: the nearby patch whose surroundings
 *           look most like the target's surroundings (classic patch search, NOT generative AI)
 *
 * Spots are stored as parameters in mask space (centred source px / long edge), exactly like
 * masks, so they follow the picture through crop, rotate and perspective. They are applied to
 * the SOURCE pixels before geometry and before every tonal adjustment. The original file is
 * never modified: the retouched pixels are a derived, disposable cache.
 */
import { uid } from '../masks/types';

export type SpotKind = 'clone' | 'heal' | 'remove';

export interface Spot {
  id: string;
  kind: SpotKind;
  /** Target centre (the area being fixed), mask space. */
  x: number;
  y: number;
  /** Source centre (where pixels come from), mask space. Ignored for `remove` (found automatically). */
  sx: number;
  sy: number;
  /** Radius, mask space (fraction of the long edge). */
  r: number;
  /** 0..1 — fraction of the radius over which the edge fades out. */
  feather: number;
  /** 0..1 */
  opacity: number;
  enabled: boolean;
}

export const MAX_SPOTS = 64;
export const MIN_SPOT_RADIUS = 0.002;
export const MAX_SPOT_RADIUS = 0.25;

export const SPOT_KIND_LABEL: Record<SpotKind, string> = { clone: 'Clone', heal: 'Heal', remove: 'Remove' };

export const clampRadius = (r: number) => Math.min(MAX_SPOT_RADIUS, Math.max(MIN_SPOT_RADIUS, r));

export function newSpot(kind: SpotKind, x: number, y: number, r: number, source: { sx: number; sy: number }, feather = 0.4, opacity = 1): Spot {
  return { id: uid(), kind, x, y, sx: source.sx, sy: source.sy, r: clampRadius(r), feather, opacity, enabled: true };
}

/** Validate untrusted spots (from storage or a pasted preset). Drops malformed entries. */
export function normalizeSpots(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const out: Spot[] = [];
  for (const s of raw.slice(0, MAX_SPOTS)) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
    const kind: SpotKind = s.kind === 'clone' || s.kind === 'remove' ? s.kind : 'heal';
    out.push({
      id: s.id, kind,
      x: num(s.x, 0), y: num(s.y, 0), sx: num(s.sx, 0), sy: num(s.sy, 0),
      r: clampRadius(num(s.r, 0.02)),
      feather: Math.min(1, Math.max(0, num(s.feather, 0.4))),
      opacity: Math.min(1, Math.max(0, num(s.opacity, 1))),
      enabled: s.enabled !== false,
    });
  }
  return out;
}
