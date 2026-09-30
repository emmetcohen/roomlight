import { describe, expect, it } from 'vitest';
import { NO_FILTER, defaultInfo, filterIsActive, normalizeInfo, type PhotoInfo } from '../src/library/types';
import { matchesText, parseKeywords, queryPhotos, sortPhotos, type Queryable } from '../src/library/query';

const P = (id: string, name: string, addedAt: number, info: Partial<PhotoInfo> = {}, edited = false): Queryable => ({ id, name, addedAt, edited, info: { ...defaultInfo(id), ...info } });
const lib: Queryable[] = [
  P('a', 'IMG_0010.jpg', 1, { rating: 5, flag: 'pick', label: 'red', keywords: ['beach', 'sunset'], albumIds: ['trip'], exif: { model: 'Model One', lens: '35mm', capturedAt: 300 } }, true),
  P('b', 'IMG_0002.jpg', 2, { rating: 3, flag: 'none', keywords: ['city'], title: 'Night street', exif: { model: 'Model Two', capturedAt: 100 } }),
  P('c', 'img_0100.jpg', 3, { rating: 0, flag: 'reject', label: 'blue', caption: 'Blurry beach walk', albumIds: ['trip'] }),
  P('d', 'portrait.jpg', 4, { rating: 4, flag: 'pick', albumIds: [] }, true),
];
const ids = (l: Queryable[]) => l.map((p) => p.id).join('');
const q = (f: Partial<typeof NO_FILTER>, sort: 'added' | 'name' | 'capture' | 'rating' = 'added', desc = false) => ids(queryPhotos(lib, { ...NO_FILTER, ...f }, sort, desc));

describe('library query', () => {
  it('no filter shows everything', () => { expect(q({})).toBe('abcd'); expect(filterIsActive(NO_FILTER)).toBe(false); });
  it('rating filter is "at least"', () => { expect(q({ minRating: 4 })).toBe('ad'); expect(q({ minRating: 5 })).toBe('a'); expect(filterIsActive({ ...NO_FILTER, minRating: 1 })).toBe(true); });
  it('flag, label, album and edited filters', () => {
    expect(q({ flags: ['pick'] })).toBe('ad'); expect(q({ flags: ['reject', 'none'] })).toBe('bc');
    expect(q({ label: 'blue' })).toBe('c'); expect(q({ albumId: 'trip' })).toBe('ac');
    expect(q({ edited: true })).toBe('ad'); expect(q({ edited: false })).toBe('bc');
  });
  it('filters combine (AND)', () => { expect(q({ minRating: 3, flags: ['pick'], albumId: 'trip' })).toBe('a'); expect(q({ minRating: 5, flags: ['reject'] })).toBe(''); });
  it('text search covers name, title, caption, keywords and camera — all words must match, any case', () => {
    expect(q({ text: 'beach' })).toBe('ac'); // keyword on a, caption on c
    expect(q({ text: 'BEACH sunset' })).toBe('a');
    expect(q({ text: 'night' })).toBe('b'); expect(q({ text: 'model two' })).toBe('b'); expect(q({ text: '35mm' })).toBe('a');
    expect(q({ text: 'img_0002' })).toBe('b'); expect(q({ text: 'nothing matches' })).toBe(''); expect(matchesText(lib[0], '   ')).toBe(true);
  });
  it('sorts by name naturally (2 before 10), capture time, rating; stable on ties', () => {
    expect(q({}, 'name')).toBe('bacd'); // IMG_0002, IMG_0010, img_0100, portrait
    expect(q({}, 'capture')).toBe('cdba'); // no EXIF date → falls back to import time (c=3, d=4), then b(100), a(300)
    expect(q({}, 'rating', true)).toBe('adbc'); expect(q({}, 'rating')).toBe('cbda');
    expect(ids(sortPhotos(lib, 'added', true))).toBe('dcba');
  });
  it('sorting never mutates the input', () => { const before = ids(lib); sortPhotos(lib, 'name', true); expect(ids(lib)).toBe(before); });
});

describe('info + keywords', () => {
  it('parseKeywords trims, splits on , ; newline and de-duplicates case-insensitively', () => {
    expect(parseKeywords(' Beach, sunset ;beach\n  Sea ,, ')).toEqual(['Beach', 'sunset', 'Sea']); expect(parseKeywords('')).toEqual([]);
  });
  it('normalizeInfo repairs bad stored data', () => {
    expect(normalizeInfo({ rating: 9, flag: 'x' as never, label: 'pink' as never, keywords: ['a', 3 as never] }, 'id')).toMatchObject({ photoId: 'id', rating: 5, flag: 'none', label: null, keywords: ['a'] });
    expect(normalizeInfo(undefined, 'z')).toEqual(defaultInfo('z'));
    expect(normalizeInfo({ rating: -3 }, 'z').rating).toBe(0);
  });
});
