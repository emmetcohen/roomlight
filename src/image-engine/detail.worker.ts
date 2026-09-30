/// <reference lib="webworker" />
import { applyAllDetail } from './detail';
import type { DetailInput } from './detailInput';

export type DetailIn = { id: number; data: Uint8ClampedArray; w: number; h: number; input: DetailInput; scale: number };
export type DetailOut = { id: number; data: Uint8ClampedArray } | { id: number; error: string };

self.onmessage = (e: MessageEvent<DetailIn>) => {
  const { id, data, w, h, input, scale } = e.data;
  try {
    const out = applyAllDetail(data, w, h, input.params, input.masks, scale);
    const res = out === data ? data : out;
    (self as unknown as Worker).postMessage({ id, data: res } satisfies DetailOut, [res.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies DetailOut);
  }
};
