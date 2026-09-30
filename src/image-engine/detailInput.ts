import type { Mask } from '../masks/types';
import { detailActive, detailParamsOf, maskDetailActive, type DetailParams } from './detail';
import type { EditParams } from './params';

/** What the Detail pre-pass needs from an edit (and nothing else, so unrelated edits never re-run it). */
export interface DetailInput { params: DetailParams; masks: Mask[] }

export function detailInputOf(p: EditParams): DetailInput | null {
  const params = detailParamsOf(p as unknown as Record<string, unknown>);
  if (!detailActive(params, p.masks)) return null;
  return { params, masks: maskDetailActive(p.masks) ? p.masks : [] };
}

/** Stable key: equal keys produce identical output for the same source. */
export const detailKey = (i: DetailInput): string => JSON.stringify([i.params, i.masks]);
