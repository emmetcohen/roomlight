/**
 * Lens profiles: named sets of correction amounts, in the same units as the manual sliders
 * (−100…100). The effective correction is profile + manual adjustment.
 *
 * Roomlight ships NO measured camera/lens database. The two "example" profiles below only
 * demonstrate the mechanism with generic, plausible numbers and are labelled as such in the UI.
 * Real profiles (e.g. converted from Lensfun or measured by the user) are added at run time
 * with `registerLensProfile`.
 */
export interface LensProfile {
  id: string;
  name: string;
  /** Distortion correction (+ corrects barrel, − corrects pincushion). */
  distortion: number;
  /** Vignetting correction (+ brightens the corners). */
  vignetting: number;
  /** Lateral chromatic aberration correction (radial red/blue scale). */
  chromaticAberration: number;
  /** True for illustrative placeholders that are not derived from a real lens. */
  example?: boolean;
}

export const NO_PROFILE = 'none';

const profiles = new Map<string, LensProfile>();
export function registerLensProfile(p: LensProfile): void { profiles.set(p.id, p); }
export function getLensProfile(id: string): LensProfile | null { return id === NO_PROFILE ? null : profiles.get(id) ?? null; }
export function listLensProfiles(): LensProfile[] { return [...profiles.values()]; }

registerLensProfile({ id: 'example-wide', name: 'Example: generic wide-angle zoom', distortion: 35, vignetting: 30, chromaticAberration: 12, example: true });
registerLensProfile({ id: 'example-tele', name: 'Example: generic telephoto (pincushion)', distortion: -12, vignetting: 10, chromaticAberration: 6, example: true });

export interface LensAmounts { distortion: number; vignetting: number; chromaticAberration: number }

/** Profile + manual sliders, clamped to the slider range. */
export function effectiveLens(profileId: string, manual: LensAmounts): LensAmounts {
  const p = getLensProfile(profileId);
  const c = (v: number) => Math.max(-100, Math.min(100, v));
  return {
    distortion: c((p?.distortion ?? 0) + manual.distortion),
    vignetting: c((p?.vignetting ?? 0) + manual.vignetting),
    chromaticAberration: c((p?.chromaticAberration ?? 0) + manual.chromaticAberration),
  };
}

/** Model constants: slider ±100 -> radial coefficient / shift. */
export const LENS_DISTORTION_K = 0.25; // rs = rc·(1 − k·rc²), k = distortion/100·0.25, rc = radius / half-diagonal
export const LENS_CA_SHIFT = 0.004; // red sampled at radius·(1+s), blue at radius·(1−s), s = ca/100·0.004
export const LENS_VIGNETTE_STOPS = 2; // gain = 2^(vignetting/100 · 2 · rc²)
