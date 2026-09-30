/** Library data model (Phase 6): per-photo info, albums, filters. Independent of the edit parameters. */
import { normalizeParams, type EditParams } from '../image-engine/params';
import type { ExifInfo } from '../metadata/exif';

export type Flag = 'none' | 'pick' | 'reject';
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];
export const LABEL_CSS: Record<ColorLabel, string> = { red: '#e5484d', yellow: '#e8c72f', green: '#3fb950', blue: '#3b82f6', purple: '#a06cf0' };

/** A named copy of ALL of a photo's edit parameters (Snapshots panel). */
export interface Snapshot { id: string; name: string; time: number; params: EditParams }

/** Everything the user (or the file) says about a photo, apart from its pixels and its edits. Stored separately so the original record is never rewritten. */
export interface PhotoInfo {
  photoId: string;
  rating: number; // 0..5
  flag: Flag;
  label: ColorLabel | null;
  title: string;
  caption: string;
  keywords: string[];
  albumIds: string[];
  snapshots: Snapshot[];
  /** undefined = not read yet; null = read, none found. */
  exif?: ExifInfo | null;
}

export interface AlbumRecord { id: string; name: string; createdAt: number }

export const defaultInfo = (photoId: string): PhotoInfo => ({ photoId, rating: 0, flag: 'none', label: null, title: '', caption: '', keywords: [], albumIds: [], snapshots: [] });

/** Validate untrusted stored info. */
export function normalizeInfo(raw: Partial<PhotoInfo> | undefined | null, photoId: string): PhotoInfo {
  const d = defaultInfo(photoId);
  if (!raw || typeof raw !== 'object') return d;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    photoId,
    rating: typeof raw.rating === 'number' ? Math.min(5, Math.max(0, Math.round(raw.rating))) : 0,
    flag: raw.flag === 'pick' || raw.flag === 'reject' ? raw.flag : 'none',
    label: COLOR_LABELS.includes(raw.label as ColorLabel) ? (raw.label as ColorLabel) : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    keywords: strs(raw.keywords),
    albumIds: strs(raw.albumIds),
    snapshots: Array.isArray(raw.snapshots)
      ? raw.snapshots.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string').slice(0, 50).map((x) => ({ id: x.id, name: x.name.slice(0, 80), time: typeof x.time === 'number' ? x.time : 0, params: normalizeParams(x.params as unknown as Record<string, unknown>) }))
      : [],
    exif: raw.exif === undefined ? undefined : raw.exif,
  };
}

export type SortKey = 'added' | 'name' | 'capture' | 'rating';

export interface LibraryFilter {
  /** Show only photos rated at least this (0 = no filter). */
  minRating: number;
  /** null = any; otherwise only these flags. */
  flags: Flag[] | null;
  label: ColorLabel | null;
  albumId: string | null;
  text: string;
  /** null = any, true = only photos with edits, false = only unedited. */
  edited: boolean | null;
}
export const NO_FILTER: LibraryFilter = { minRating: 0, flags: null, label: null, albumId: null, text: '', edited: null };
export const filterIsActive = (f: LibraryFilter): boolean =>
  f.minRating > 0 || f.flags !== null || f.label !== null || f.albumId !== null || f.text.trim() !== '' || f.edited !== null;
