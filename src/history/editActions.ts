/** Pure edit operations over a History<EditParams>. The store is thin glue around these. */
import { defaultCurves, type CurveChannel, type CurvePoint } from '../image-engine/curves';
import {
  DEFAULT_PARAMS, SECTIONS, SLIDER_BY_KEY, clampParam, keysOfSection, paramsEqual,
  type EditParams, type ParamKey, type ScalarParams, type SectionId,
} from '../image-engine/params';
import { apply, commit, present, preview, type History } from './history';

export type EditHistory = History<EditParams>;
export type ParamPatch = Partial<ScalarParams>;

const CURVE_LABEL: Record<CurveChannel, string> = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };

function patched(base: EditParams, patch: ParamPatch): EditParams {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) (next as unknown as Record<string, number>)[k] = clampParam(k as ParamKey, v as number);
  return next;
}

/** Live update of one or more scalars during a drag / typing. Not recorded until committed. */
export function previewPatch(h: EditHistory, patch: ParamPatch): EditHistory {
  return preview(h, patched(present(h), patch));
}
export function previewParam(h: EditHistory, key: ParamKey, value: number): EditHistory {
  return previewPatch(h, { [key]: value });
}

export function commitLabel(h: EditHistory, label: string, coalesceKey?: string): EditHistory {
  return commit(h, label, paramsEqual, coalesceKey ? { key: coalesceKey } : {});
}
export function commitParam(h: EditHistory, key: ParamKey, coalesce = false): EditHistory {
  return commitLabel(h, `Adjust ${SLIDER_BY_KEY[key].fullLabel}`, coalesce ? `param:${key}` : undefined);
}

export function setParams(h: EditHistory, patch: ParamPatch, label: string): EditHistory {
  return apply(h, patched(present(h), patch), label, paramsEqual);
}

// ---- tone curve
export function previewCurve(h: EditHistory, channel: CurveChannel, points: CurvePoint[]): EditHistory {
  const cur = present(h);
  return preview(h, { ...cur, curves: { ...cur.curves, [channel]: points } });
}
export function commitCurve(h: EditHistory, channel: CurveChannel): EditHistory {
  return commitLabel(h, `Adjust ${CURVE_LABEL[channel]} Curve`);
}
export function resetCurve(h: EditHistory, channel: CurveChannel | 'all'): EditHistory {
  const cur = present(h);
  const fresh = defaultCurves();
  const curves = channel === 'all' ? fresh : { ...cur.curves, [channel]: fresh[channel] };
  return apply(h, { ...cur, curves }, channel === 'all' ? 'Reset Tone Curve' : `Reset ${CURVE_LABEL[channel]} Curve`, paramsEqual);
}

// ---- resets
export function resetParam(h: EditHistory, key: ParamKey): EditHistory {
  return setParams(h, { [key]: DEFAULT_PARAMS[key] }, `Reset ${SLIDER_BY_KEY[key].fullLabel}`);
}

export function resetKeys(h: EditHistory, keys: ParamKey[], label: string): EditHistory {
  const patch: ParamPatch = {};
  for (const k of keys) patch[k] = DEFAULT_PARAMS[k];
  return setParams(h, patch, label);
}

export function resetSection(h: EditHistory, section: SectionId): EditHistory {
  const label = `Reset ${SECTIONS.find((s) => s.id === section)!.label}`;
  if (section === 'curve') return resetCurve(h, 'all');
  return resetKeys(h, keysOfSection(section), label);
}

export function resetAll(h: EditHistory): EditHistory {
  return apply(h, { ...DEFAULT_PARAMS, curves: defaultCurves() }, 'Reset All', paramsEqual);
}
