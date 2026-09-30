/**
 * AI selection architecture (Subject / Sky / Background).
 *
 * No segmentation model is bundled, and Roomlight does not pretend otherwise: the UI buttons
 * are disabled and say so until a provider is registered. A provider receives the image and
 * returns a greyscale mask raster (RASTER_SIZE² Uint8, covering mask-space [-0.5,0.5]²); the
 * result is used exactly like a brush raster by the renderer.
 *
 *   registerSegmentationProvider({ id, name, available, segment })
 */
import type { SegmentKind } from './types';

export interface SegmentationProvider {
  id: string;
  name: string;
  /** Whether the model can run here (WebGPU present, weights downloaded, ...). */
  available(): Promise<boolean> | boolean;
  /** Produce a RASTER_SIZE² mask (0..255) for the requested region. */
  segment(image: ImageBitmap, kind: SegmentKind): Promise<Uint8Array>;
}

const providers: SegmentationProvider[] = [];
export const registerSegmentationProvider = (p: SegmentationProvider) => { providers.push(p); };
export const clearSegmentationProviders = () => { providers.length = 0; };
export const listSegmentationProviders = () => providers.slice();

export async function firstAvailableProvider(): Promise<SegmentationProvider | null> {
  for (const p of providers) if (await p.available()) return p;
  return null;
}

/** Rasters produced by providers, keyed by component id. Used by the renderer like brush rasters. */
const rasters = new Map<string, Uint8Array>();
export const setSegmentRaster = (componentId: string, data: Uint8Array) => { rasters.set(componentId, data); };
export const getSegmentRaster = (componentId: string) => rasters.get(componentId) ?? null;
export const clearSegmentRasters = () => { rasters.clear(); };
