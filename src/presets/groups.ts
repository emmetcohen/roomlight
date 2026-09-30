/**
 * Groups of settings that copy/paste and presets work with. A group is a set of scalar
 * parameters plus (optionally) non-scalar ones. Everything is derived from the slider
 * registry, so a new slider lands in its group automatically.
 */
import { SLIDERS, type ParamKey, type SectionId } from '../image-engine/params';

export type GroupId = 'wb' | 'tone' | 'presence' | 'color' | 'curve' | 'mixer' | 'grading' | 'vignette' | 'grain' | 'lens' | 'geometry' | 'crop' | 'masks' | 'spots';
export type NonScalar = 'curves' | 'lensProfile' | 'crop' | 'masks' | 'spots';

export interface CopyGroup {
  id: GroupId;
  label: string;
  keys: ParamKey[];
  nonScalar: NonScalar[];
  /** Checked by default in the copy dialog. Photo-specific content (crop, masks, spots) is off by default. */
  defaultOn: boolean;
  note?: string;
}

const keysOf = (section: SectionId): ParamKey[] => SLIDERS.filter((s) => s.section === section).map((s) => s.key);

export const COPY_GROUPS: CopyGroup[] = [
  { id: 'wb', label: 'White balance', keys: keysOf('whiteBalance'), nonScalar: [], defaultOn: true },
  { id: 'tone', label: 'Tone', keys: keysOf('tone'), nonScalar: [], defaultOn: true },
  { id: 'presence', label: 'Texture, clarity, dehaze', keys: keysOf('presence'), nonScalar: [], defaultOn: true },
  { id: 'color', label: 'Vibrance & saturation', keys: keysOf('color'), nonScalar: [], defaultOn: true },
  { id: 'curve', label: 'Tone curve', keys: [], nonScalar: ['curves'], defaultOn: true },
  { id: 'mixer', label: 'Color mixer', keys: keysOf('mixer'), nonScalar: [], defaultOn: true },
  { id: 'grading', label: 'Color grading', keys: keysOf('grading'), nonScalar: [], defaultOn: true },
  { id: 'vignette', label: 'Vignette', keys: keysOf('vignette'), nonScalar: [], defaultOn: true },
  { id: 'grain', label: 'Grain', keys: keysOf('grain'), nonScalar: [], defaultOn: true },
  { id: 'lens', label: 'Lens corrections', keys: keysOf('lens'), nonScalar: ['lensProfile'], defaultOn: true },
  { id: 'geometry', label: 'Geometry (perspective)', keys: keysOf('geometry'), nonScalar: [], defaultOn: false, note: 'Depends on the photo’s content.' },
  { id: 'crop', label: 'Crop, angle & orientation', keys: keysOf('crop'), nonScalar: ['crop'], defaultOn: false, note: 'Depends on the photo’s content.' },
  { id: 'masks', label: 'Local adjustments (masks)', keys: [], nonScalar: ['masks'], defaultOn: false, note: 'Positions are relative to the picture, so they only make sense on similar framing.' },
  { id: 'spots', label: 'Retouch spots', keys: [], nonScalar: ['spots'], defaultOn: false, note: 'Spots belong to the blemishes of one photo.' },
];

export const GROUP_BY_ID = Object.fromEntries(COPY_GROUPS.map((g) => [g.id, g])) as Record<GroupId, CopyGroup>;
export const DEFAULT_GROUPS: GroupId[] = COPY_GROUPS.filter((g) => g.defaultOn).map((g) => g.id);
export const ALL_GROUPS: GroupId[] = COPY_GROUPS.map((g) => g.id);
