import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { EDIT_SCHEMA_VERSION, IndexedDbPhotoStore } from '../src/storage/db';
import { normalizeParams } from '../src/image-engine/params';

describe('IndexedDB storage', () => {
  it('stores the original bytes untouched, separately from edit parameters', async () => {
    const db = new IndexedDbPhotoStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250]);
    await db.putPhoto({ id: 'p1', name: 'a.jpg', type: 'image/jpeg', size: 6, width: 10, height: 5, addedAt: 1, original: new Blob([bytes]), thumbnail: null });
    await db.putEdits({ photoId: 'p1', version: EDIT_SCHEMA_VERSION, edits: { exposure: 1.25, contrast: 10 }, updatedAt: 2 });

    const [photo] = await db.listPhotos();
    expect(Array.from(new Uint8Array(await photo.original.arrayBuffer()))).toEqual(Array.from(bytes));
    const e = await db.getEdits('p1');
    expect(normalizeParams(e?.edits).exposure).toBe(1.25);

    // Updating edits never touches the photo record.
    await db.putEdits({ photoId: 'p1', version: EDIT_SCHEMA_VERSION, edits: { exposure: 0 }, updatedAt: 3 });
    const [again] = await db.listPhotos();
    expect(again.size).toBe(6);

    await db.deletePhoto('p1');
    expect(await db.listPhotos()).toEqual([]);
    expect(await db.getEdits('p1')).toBeUndefined();
  });

  it('remembers meta', async () => {
    const db = new IndexedDbPhotoStore();
    await db.setMeta('lastPhotoId', 'abc');
    expect(await db.getMeta('lastPhotoId')).toBe('abc');
  });
});
