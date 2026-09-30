/**
 * Presets and copied settings are the same thing: a SPARSE set of parameters (only the groups
 * that were chosen). Applying one overwrites exactly those parameters and leaves all others
 * alone, as one undoable history step.
 */
import { normalizeParams, type EditParams, type ParamKey, type ScalarParams } from '../image-engine/params';
import { uid } from '../masks/types';
import { ALL_GROUPS, GROUP_BY_ID, type GroupId } from './groups';

export interface PresetData extends Partial<ScalarParams> {
  curves?: EditParams['curves'];
  lensProfile?: string;
  crop?: EditParams['crop'];
  masks?: EditParams['masks'];
  spots?: EditParams['spots'];
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Take the chosen groups out of a photo's parameters. */
export function extractPreset(p: EditParams, groups: GroupId[]): PresetData {
  const out: Record<string, unknown> = {};
  for (const id of groups) {
    const g = GROUP_BY_ID[id];
    for (const k of g.keys) out[k] = p[k];
    for (const n of g.nonScalar) out[n] = clone(p[n]);
  }
  return out as PresetData;
}

/** Which groups a preset touches (used to show what it contains). */
export function groupsIn(data: PresetData): GroupId[] {
  return ALL_GROUPS.filter((id) => {
    const g = GROUP_BY_ID[id];
    return g.keys.some((k) => k in data) || g.nonScalar.some((n) => n in data);
  });
}

/** Fresh ids so applying the same preset twice never produces duplicate mask/spot ids. */
function reid(data: PresetData): PresetData {
  const d = { ...data };
  if (d.masks) d.masks = d.masks.map((m) => ({ ...m, id: uid(), components: m.components.map((c) => ({ ...c, id: uid() })) }));
  if (d.spots) d.spots = d.spots.map((s) => ({ ...s, id: uid() }));
  return d;
}

/** Apply a preset onto parameters. `only` limits it to some groups. The result is validated/clamped. */
export function applyPreset(p: EditParams, data: PresetData, only?: GroupId[]): EditParams {
  const allowed = only ? new Set(only) : null;
  const d = reid(clone(data)) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...p };
  for (const id of ALL_GROUPS) {
    if (allowed && !allowed.has(id)) continue;
    const g = GROUP_BY_ID[id];
    for (const k of g.keys) if (typeof d[k] === 'number') next[k] = d[k];
    for (const n of g.nonScalar) if (n in d) next[n] = d[n];
  }
  return normalizeParams(next);
}

/** Validate a preset from storage or a file: unknown keys dropped, values clamped. Returns null when nothing usable remains. */
export function sanitizePreset(raw: unknown): PresetData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = normalizeParams(r);
  const out: Record<string, unknown> = {};
  for (const id of ALL_GROUPS) {
    const g = GROUP_BY_ID[id];
    for (const k of g.keys as ParamKey[]) if (typeof r[k] === 'number') out[k] = n[k];
    for (const nsc of g.nonScalar) if (nsc in r) out[nsc] = n[nsc];
  }
  return Object.keys(out).length ? (out as PresetData) : null;
}
