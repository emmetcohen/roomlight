/** Filtering, searching and sorting the library. Pure functions over plain data. */
import type { PhotoInfo, LibraryFilter, SortKey } from './types';

export interface Queryable {
  id: string;
  name: string;
  addedAt: number;
  info: PhotoInfo;
  /** has non-default edits */
  edited: boolean;
}

function haystack(p: Queryable): string {
  const e = p.info.exif;
  return [p.name, p.info.title, p.info.caption, ...p.info.keywords, e?.make, e?.model, e?.lens].filter(Boolean).join('\n').toLowerCase();
}

/** Every whitespace-separated word of `text` must appear (case-insensitive) in the name, title, caption, keywords or camera/lens. */
export function matchesText(p: Queryable, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = haystack(p);
  return words.every((w) => h.includes(w));
}

export function matches(p: Queryable, f: LibraryFilter): boolean {
  if (f.minRating > 0 && p.info.rating < f.minRating) return false;
  if (f.flags && !f.flags.includes(p.info.flag)) return false;
  if (f.label && p.info.label !== f.label) return false;
  if (f.albumId && !p.info.albumIds.includes(f.albumId)) return false;
  if (f.edited !== null && p.edited !== f.edited) return false;
  return matchesText(p, f.text);
}

export function sortPhotos<T extends Queryable>(list: T[], key: SortKey, descending = false): T[] {
  const cmp = (a: T, b: T): number => {
    switch (key) {
      case 'name': return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      case 'capture': return (a.info.exif?.capturedAt ?? a.addedAt) - (b.info.exif?.capturedAt ?? b.addedAt);
      case 'rating': return a.info.rating - b.info.rating;
      default: return a.addedAt - b.addedAt;
    }
  };
  const out = [...list].sort((a, b) => (descending ? -cmp(a, b) : cmp(a, b)) || (a.addedAt - b.addedAt) || a.id.localeCompare(b.id));
  return out;
}

export function queryPhotos<T extends Queryable>(list: T[], f: LibraryFilter, sort: SortKey, descending: boolean): T[] {
  return sortPhotos(list.filter((p) => matches(p, f)), sort, descending);
}

/** Split "sunset, beach,  Sunset" into unique, trimmed keywords (case-insensitive unique, first spelling kept). */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const k of text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const low = k.toLowerCase();
    if (!seen.has(low)) { seen.add(low); out.push(k); }
  }
  return out;
}
