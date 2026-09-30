/** Pure edit operations over a History<EditParams>. The store is thin glue around these. */
import { DEFAULT_PARAMS, SECTIONS, SLIDER_BY_KEY, clampParam, keysOfSection, paramsEqual, type EditParams, type ParamKey, type SectionId } from '../image-engine/params';
import { apply, commit, present, preview, type History } from './history';

export type EditHistory = History<EditParams>;

/** Live update during a drag / typing. Not recorded until `commitParam`. */
export function previewParam(h: EditHistory, key: ParamKey, value: number): EditHistory {
  return preview(h, { ...present(h), [key]: clampParam(key, value) });
}

export function commitParam(h: EditHistory, key: ParamKey, coalesce = false): EditHistory {
  return commit(h, `Adjust ${SLIDER_BY_KEY[key].label}`, paramsEqual, coalesce ? { key: `param:${key}` } : {});
}

export function setParams(h: EditHistory, patch: Partial<EditParams>, label: string): EditHistory {
  const next = { ...present(h) };
  for (const [k, v] of Object.entries(patch)) next[k as ParamKey] = clampParam(k as ParamKey, v as number);
  return apply(h, next, label, paramsEqual);
}

export function resetParam(h: EditHistory, key: ParamKey): EditHistory {
  return setParams(h, { [key]: DEFAULT_PARAMS[key] }, `Reset ${SLIDER_BY_KEY[key].label}`);
}

export function resetSection(h: EditHistory, section: SectionId): EditHistory {
  const patch: Partial<EditParams> = {};
  for (const k of keysOfSection(section)) patch[k] = DEFAULT_PARAMS[k];
  const label = SECTIONS.find((s) => s.id === section)!.label;
  return setParams(h, patch, `Reset ${label}`);
}

export function resetAll(h: EditHistory): EditHistory {
  return apply(h, { ...DEFAULT_PARAMS }, 'Reset All', paramsEqual);
}
