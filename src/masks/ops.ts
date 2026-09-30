/** Pure, immutable edit helpers for the mask list (structural sharing: untouched masks keep their identity). */
import { MAX_COMPONENTS, MAX_MASKS, MAX_RASTERS, uid, type LocalKey, type Mask, type MaskComponent, type Shape } from './types';

export const componentCount = (ms: Mask[]) => ms.reduce((n, m) => n + m.components.length, 0);
const isRaster = (s: Shape) => s.type === 'brush' || s.type === 'segment';
export const rasterCount = (ms: Mask[]) => ms.reduce((n, m) => n + m.components.filter((c) => isRaster(c.shape)).length, 0);

/** Why a mask or component of this shape can't be added right now, or null if it can. */
export function limitReason(ms: Mask[], shape: Shape, newMask: boolean): string | null {
  if (newMask && ms.length >= MAX_MASKS) return `At most ${MAX_MASKS} masks per photo.`;
  if (componentCount(ms) >= MAX_COMPONENTS) return `At most ${MAX_COMPONENTS} mask components per photo.`;
  if (isRaster(shape) && rasterCount(ms) >= MAX_RASTERS) return `At most ${MAX_RASTERS} brush/selection layers per photo.`;
  return null;
}

export const addMask = (ms: Mask[], m: Mask): Mask[] => [...ms, m];
export const removeMask = (ms: Mask[], id: string): Mask[] => ms.filter((m) => m.id !== id);
export const updateMask = (ms: Mask[], id: string, fn: (m: Mask) => Mask): Mask[] => ms.map((m) => (m.id === id ? fn(m) : m));

export const addComponent = (ms: Mask[], maskId: string, c: MaskComponent): Mask[] =>
  updateMask(ms, maskId, (m) => ({ ...m, components: [...m.components, c] }));

/** Removing the last component removes the mask (an empty mask selects nothing and has no handles). */
export function removeComponent(ms: Mask[], maskId: string, compId: string): Mask[] {
  const m = ms.find((x) => x.id === maskId);
  if (!m) return ms;
  if (m.components.length <= 1) return removeMask(ms, maskId);
  return updateMask(ms, maskId, (x) => ({ ...x, components: x.components.filter((c) => c.id !== compId) }));
}

export const updateComponent = (ms: Mask[], maskId: string, compId: string, fn: (c: MaskComponent) => MaskComponent): Mask[] =>
  updateMask(ms, maskId, (m) => ({ ...m, components: m.components.map((c) => (c.id === compId ? fn(c) : c)) }));

export const updateShape = <S extends Shape>(ms: Mask[], maskId: string, compId: string, fn: (s: S) => S): Mask[] =>
  updateComponent(ms, maskId, compId, (c) => ({ ...c, shape: fn(c.shape as S) }));

/** Set a local adjustment; a value of 0 removes the key so "no adjustment" is represented uniquely. */
export function setAdjust(ms: Mask[], maskId: string, key: LocalKey, value: number): Mask[] {
  return updateMask(ms, maskId, (m) => {
    const adjust = { ...m.adjust };
    if (value === 0) delete adjust[key]; else adjust[key] = value;
    return { ...m, adjust };
  });
}

export function duplicateMask(ms: Mask[], id: string): Mask[] {
  const m = ms.find((x) => x.id === id);
  if (!m || ms.length >= MAX_MASKS || componentCount(ms) + m.components.length > MAX_COMPONENTS || rasterCount(ms) + m.components.filter((c) => isRaster(c.shape)).length > MAX_RASTERS) return ms;
  return [...ms, { ...m, id: uid(), name: `${m.name} copy`, components: m.components.map((c) => ({ ...c, id: uid() })) }];
}
