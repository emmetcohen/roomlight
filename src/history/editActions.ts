/** Pure edit operations over a History<EditParams>. The store is thin glue around these. */
import { defaultCurves, type CurveChannel, type CurvePoint } from '../image-engine/curves';
import {
  DEFAULT_PARAMS, SECTIONS, SLIDER_BY_KEY, clampParam, keysOfSection, paramsEqual,
  type EditParams, type ParamKey, type ScalarParams, type SectionId,
} from '../image-engine/params';
import { constrainCrop, resetCropTool } from '../geometry/cropActions';
import { fullCrop } from '../geometry/crop';
import { NO_PROFILE } from '../lens/profiles';
import { apply, commit, present, preview, type History } from './history';

export type EditHistory = History<EditParams>;
export type ParamPatch = Partial<ScalarParams>;

/** Extra context some edits need: the source's width/height, so geometry changes can keep the crop inside the picture. */
export interface EditCtx { aspect: number }

const CURVE_LABEL: Record<CurveChannel, string> = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };

function patched(base: EditParams, patch: ParamPatch, ctx?: EditCtx): EditParams {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) (next as unknown as Record<string, number>)[k] = clampParam(k as ParamKey, v as number);
  return ctx ? constrainCrop(next, base, ctx.aspect) : next;
}

/** Arbitrary edit of the parameters (masks, crop, ...) as a live update; recorded on commitLabel. */
export function previewEdit(h: EditHistory, fn: (p: EditParams) => EditParams): EditHistory {
  return preview(h, fn(present(h)));
}
/** Arbitrary edit, recorded immediately as one history entry. */
export function applyEdit(h: EditHistory, fn: (p: EditParams) => EditParams, label: string): EditHistory {
  return apply(h, fn(present(h)), label, paramsEqual);
}

/** Live update of one or more scalars during a drag / typing. Not recorded until committed. */
export function previewPatch(h: EditHistory, patch: ParamPatch, ctx?: EditCtx): EditHistory {
  return preview(h, patched(present(h), patch, ctx));
}
export function previewParam(h: EditHistory, key: ParamKey, value: number, ctx?: EditCtx): EditHistory {
  return previewPatch(h, { [key]: value }, ctx);
}

export function commitLabel(h: EditHistory, label: string, coalesceKey?: string): EditHistory {
  return commit(h, label, paramsEqual, coalesceKey ? { key: coalesceKey } : {});
}
export function commitParam(h: EditHistory, key: ParamKey, coalesce = false): EditHistory {
  return commitLabel(h, `Adjust ${SLIDER_BY_KEY[key].fullLabel}`, coalesce ? `param:${key}` : undefined);
}

export function setParams(h: EditHistory, patch: ParamPatch, label: string, ctx?: EditCtx): EditHistory {
  return apply(h, patched(present(h), patch, ctx), label, paramsEqual);
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
export function resetParam(h: EditHistory, key: ParamKey, ctx?: EditCtx): EditHistory {
  return setParams(h, { [key]: DEFAULT_PARAMS[key] }, `Reset ${SLIDER_BY_KEY[key].fullLabel}`, ctx);
}

export function resetKeys(h: EditHistory, keys: ParamKey[], label: string, ctx?: EditCtx): EditHistory {
  const patch: ParamPatch = {};
  for (const k of keys) patch[k] = DEFAULT_PARAMS[k];
  return setParams(h, patch, label, ctx);
}

export function resetSection(h: EditHistory, section: SectionId): EditHistory {
  const label = `Reset ${SECTIONS.find((s) => s.id === section)!.label}`;
  if (section === 'curve') return resetCurve(h, 'all');
  if (section === 'crop') return applyEdit(h, resetCropTool, label);
  if (section === 'retouch') return applyEdit(h, (p) => ({ ...p, spots: [] }), label);
  if (section === 'lens') return applyEdit(h, (p) => ({ ...p, ...Object.fromEntries(keysOfSection('lens').map((k) => [k, DEFAULT_PARAMS[k]])), lensProfile: NO_PROFILE }), label);
  return resetKeys(h, keysOfSection(section), label);
}

export function resetAll(h: EditHistory): EditHistory {
  return apply(h, { ...DEFAULT_PARAMS, curves: defaultCurves(), crop: fullCrop(), masks: [], spots: [] }, 'Reset All', paramsEqual);
}
