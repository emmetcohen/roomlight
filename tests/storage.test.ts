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

describe('IndexedDB storage v2 (library, albums, presets)', () => {
  it('keeps per-photo info, albums and presets; deleting a photo removes its info', async () => {
    const { IDBFactory: FDBFactory } = await import('fake-indexeddb');
    const db = new IndexedDbPhotoStore(new FDBFactory());
    await db.putPhoto({ id: 'p1', name: 'a.jpg', type: 'image/jpeg', size: 1, width: 1, height: 1, addedAt: 1, original: new Blob([new Uint8Array([1])]), thumbnail: null });
    await db.putInfo({ photoId: 'p1', rating: 4, flag: 'pick', label: 'red', title: 'T', caption: 'C', keywords: ['a', 'b'], albumIds: ['al1'], exif: null });
    expect((await db.listInfo())[0]).toMatchObject({ rating: 4, flag: 'pick', keywords: ['a', 'b'] });
    await db.putAlbum({ id: 'al1', name: 'Best', createdAt: 5 });
    await db.putAlbum({ id: 'al2', name: 'Other', createdAt: 3 });
    expect((await db.listAlbums()).map((a) => a.name)).toEqual(['Other', 'Best']); // oldest first
    await db.deleteAlbum('al2');
    expect(await db.listAlbums()).toHaveLength(1);
    await db.putPreset({ id: 'u1', name: 'Mine', group: 'User', createdAt: 1, data: { exposure: 1 } });
    expect((await db.listPresets())[0].data).toEqual({ exposure: 1 });
    await db.deletePreset('u1');
    expect(await db.listPresets()).toEqual([]);
    await db.putEdits({ photoId: 'p1', version: 1, edits: {}, updatedAt: 1 });
    expect(await db.listEdits()).toHaveLength(1);
    await db.deletePhoto('p1');
    expect(await db.listInfo()).toEqual([]);
  });

  it('upgrades a version-1 database in place without losing photos or edits', async () => {
    const { IDBFactory: FDBFactory } = await import('fake-indexeddb');
    const factory = new FDBFactory();
    await new Promise<void>((res, rej) => {
      const open = factory.open('roomlight', 1);
      open.onupgradeneeded = () => {
        const d = open.result;
        d.createObjectStore('photos', { keyPath: 'id' }); d.createObjectStore('edits', { keyPath: 'photoId' }); d.createObjectStore('meta');
      };
      open.onsuccess = () => {
        const tx = open.result.transaction(['photos', 'edits'], 'readwrite');
        tx.objectStore('photos').put({ id: 'old', name: 'old.jpg', type: 'image/jpeg', size: 3, width: 2, height: 2, addedAt: 1, original: new Blob([new Uint8Array([9, 9, 9])]), thumbnail: null });
        tx.objectStore('edits').put({ photoId: 'old', version: 1, edits: { exposure: 0.5 }, updatedAt: 1 });
        tx.oncomplete = () => { open.result.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      open.onerror = () => rej(open.error);
    });
    const db = new IndexedDbPhotoStore(factory);
    expect((await db.listPhotos()).map((p) => p.id)).toEqual(['old']);
    expect(normalizeParams((await db.getEdits('old'))?.edits).exposure).toBe(0.5);
    expect(await db.listInfo()).toEqual([]); // new stores exist and are empty
    await db.putInfo({ photoId: 'old', rating: 2, flag: 'none', label: null, title: '', caption: '', keywords: [], albumIds: [] });
    expect(await db.listInfo()).toHaveLength(1);
  });
});
