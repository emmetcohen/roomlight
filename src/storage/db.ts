/**
 * IndexedDB persistence. Three stores, deliberately separate:
 *   photos  – library record + the original file Blob (never modified)
 *   edits   – edit parameters per photo (small JSON)
 *   meta    – misc key/value (last opened photo, ...)
 * Library info and edit info live apart so either can move to a server independently.
 * `PhotoStore` is the interface the app uses; IndexedDB is one implementation.
 */
import type { EditParams } from '../image-engine/params';
import type { AlbumRecord, PhotoInfo } from '../library/types';
import type { PresetData } from '../presets/snapshot';

export interface PhotoRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  addedAt: number;
  original: Blob;
  thumbnail: Blob | null;
}

export interface EditRecord {
  photoId: string;
  version: number;
  edits: Partial<EditParams>;
  updatedAt: number;
}

export const EDIT_SCHEMA_VERSION = 1;

/** A user preset. (Built-in presets live in code and are never stored.) */
export interface PresetRecord { id: string; name: string; group: string; createdAt: number; data: PresetData }

export interface PhotoStore {
  listPhotos(): Promise<PhotoRecord[]>;
  putPhoto(p: PhotoRecord): Promise<void>;
  deletePhoto(id: string): Promise<void>;
  getEdits(photoId: string): Promise<EditRecord | undefined>;
  putEdits(r: EditRecord): Promise<void>;
  listEdits(): Promise<EditRecord[]>;
  listInfo(): Promise<PhotoInfo[]>;
  putInfo(i: PhotoInfo): Promise<void>;
  listAlbums(): Promise<AlbumRecord[]>;
  putAlbum(a: AlbumRecord): Promise<void>;
  deleteAlbum(id: string): Promise<void>;
  listPresets(): Promise<PresetRecord[]>;
  putPreset(p: PresetRecord): Promise<void>;
  deletePreset(id: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

const DB_NAME = 'roomlight';
/** v1: photos, edits, meta. v2 adds info (ratings/metadata), albums and presets — purely additive, so v1 data upgrades in place. */
const DB_VERSION = 2;
type StoreName = 'photos' | 'edits' | 'meta' | 'info' | 'albums' | 'presets';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export class IndexedDbPhotoStore implements PhotoStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB) {
    this.dbPromise = new Promise((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'photoId' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('info')) db.createObjectStore('info', { keyPath: 'photoId' });
        if (!db.objectStoreNames.contains('albums')) db.createObjectStore('albums', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async store(name: StoreName, mode: IDBTransactionMode) {
    const db = await this.dbPromise;
    const tx = db.transaction(name, mode);
    return { s: tx.objectStore(name), tx };
  }

  async listPhotos(): Promise<PhotoRecord[]> {
    const { s } = await this.store('photos', 'readonly');
    const all = (await req(s.getAll())) as PhotoRecord[];
    return all.sort((a, b) => a.addedAt - b.addedAt);
  }

  async putPhoto(p: PhotoRecord): Promise<void> {
    const { s, tx } = await this.store('photos', 'readwrite');
    s.put(p);
    await txDone(tx);
  }

  async deletePhoto(id: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['photos', 'edits', 'info'], 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.objectStore('edits').delete(id);
    tx.objectStore('info').delete(id);
    await txDone(tx);
  }

  async getEdits(photoId: string): Promise<EditRecord | undefined> {
    const { s } = await this.store('edits', 'readonly');
    return (await req(s.get(photoId))) as EditRecord | undefined;
  }

  async putEdits(r: EditRecord): Promise<void> {
    const { s, tx } = await this.store('edits', 'readwrite');
    s.put(r);
    await txDone(tx);
  }

  private async all<T>(name: StoreName): Promise<T[]> {
    const { s } = await this.store(name, 'readonly');
    return (await req(s.getAll())) as T[];
  }
  private async put(name: StoreName, value: unknown): Promise<void> {
    const { s, tx } = await this.store(name, 'readwrite');
    s.put(value);
    await txDone(tx);
  }
  private async del(name: StoreName, key: string): Promise<void> {
    const { s, tx } = await this.store(name, 'readwrite');
    s.delete(key);
    await txDone(tx);
  }
  listEdits = () => this.all<EditRecord>('edits');
  listInfo = () => this.all<PhotoInfo>('info');
  putInfo = (i: PhotoInfo) => this.put('info', i);
  listAlbums = async () => (await this.all<AlbumRecord>('albums')).sort((a, b) => a.createdAt - b.createdAt);
  putAlbum = (a: AlbumRecord) => this.put('albums', a);
  deleteAlbum = (id: string) => this.del('albums', id);
  listPresets = async () => (await this.all<PresetRecord>('presets')).sort((a, b) => a.createdAt - b.createdAt);
  putPreset = (p: PresetRecord) => this.put('presets', p);
  deletePreset = (id: string) => this.del('presets', id);

  async getMeta<T>(key: string): Promise<T | undefined> {
    const { s } = await this.store('meta', 'readonly');
    return (await req(s.get(key))) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const { s, tx } = await this.store('meta', 'readwrite');
    s.put(value, key);
    await txDone(tx);
  }
}
