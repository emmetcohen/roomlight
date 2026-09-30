/**
 * Editor state. One small observable store (no extra dependency). The state object is
 * immutable; React subscribes through useSyncExternalStore.
 *
 *   photo record (library)  ──┐
 *   History<EditParams>       ├─> renderer(original bitmap, present(history))
 *   view flags                ┘
 */
import { useSyncExternalStore } from 'react';
import { autoWhiteBalance, makeAnalysisImage, sampleLinear, type AnalysisImage } from '../image-engine/analysis';
import { solveWhiteBalance } from '../image-engine/model';
import { DEFAULT_PARAMS, normalizeParams, paramsEqual, type EditParams, type ParamKey, type SectionId } from '../image-engine/params';
import { canRedo, canUndo, createHistory, jumpTo, present, redo, undo } from '../history/history';
import { commitParam, previewParam, resetAll, resetParam, resetSection, setParams, type EditHistory } from '../history/editActions';
import { decodeFile } from '../import/decoders';
import { makeThumbnail } from '../library/thumbnail';
import { EDIT_SCHEMA_VERSION, IndexedDbPhotoStore, type PhotoRecord, type PhotoStore } from '../storage/db';

/** Long edge of the working preview. Full-resolution rendering is an export-phase concern. */
export const PREVIEW_MAX_DIM = 2560;

export interface PhotoSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  size: number;
  thumbUrl: string | null;
}

export interface LoadedImage {
  photoId: string;
  bitmap: ImageBitmap;
  analysis: AnalysisImage;
}

export interface EditorState {
  ready: boolean;
  photos: PhotoSummary[];
  currentId: string | null;
  image: LoadedImage | null;
  loading: boolean;
  history: EditHistory | null;
  params: EditParams;
  canUndo: boolean;
  canRedo: boolean;
  showOriginal: boolean;
  showClipping: boolean;
  eyedropper: boolean;
  messages: string[];
}

const initial: EditorState = {
  ready: false,
  photos: [],
  currentId: null,
  image: null,
  loading: false,
  history: null,
  params: DEFAULT_PARAMS,
  canUndo: false,
  canRedo: false,
  showOriginal: false,
  showClipping: false,
  eyedropper: false,
  messages: [],
};

export class EditorStore {
  private state: EditorState = initial;
  private listeners = new Set<() => void>();
  private histories = new Map<string, EditHistory>();
  private records = new Map<string, PhotoRecord>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;

  constructor(private db: PhotoStore) {}

  // ---- subscription
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private setHistory(h: EditHistory, persist = true) {
    const id = this.state.currentId;
    if (!id) return;
    this.histories.set(id, h);
    this.set({ history: h, params: present(h), canUndo: canUndo(h), canRedo: canRedo(h) });
    if (persist) this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 400);
  }

  private async saveNow() {
    const id = this.state.currentId;
    const h = id ? this.histories.get(id) : null;
    if (!id || !h) return;
    await this.db.putEdits({ photoId: id, version: EDIT_SCHEMA_VERSION, edits: present(h), updatedAt: Date.now() });
  }

  private toast(msg: string) {
    this.set({ messages: [...this.state.messages, msg].slice(-4) });
  }
  dismissMessage = (i: number) => this.set({ messages: this.state.messages.filter((_, j) => j !== i) });

  // ---- library
  async init() {
    const records = await this.db.listPhotos();
    const photos: PhotoSummary[] = [];
    for (const r of records) {
      this.records.set(r.id, r);
      photos.push(this.summarize(r));
    }
    this.set({ photos, ready: true });
    const last = await this.db.getMeta<string>('lastPhotoId');
    const pick = photos.find((p) => p.id === last) ?? photos[0];
    if (pick) await this.select(pick.id);
  }

  private summarize(r: PhotoRecord): PhotoSummary {
    return { id: r.id, name: r.name, width: r.width, height: r.height, size: r.size, thumbUrl: r.thumbnail ? URL.createObjectURL(r.thumbnail) : null };
  }

  async importFiles(files: File[]) {
    let lastId: string | null = null;
    this.set({ loading: true });
    for (const file of files) {
      try {
        const dec = await decodeFile(file, PREVIEW_MAX_DIM);
        const thumbnail = await makeThumbnail(dec.bitmap);
        dec.bitmap.close();
        const rec: PhotoRecord = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          width: dec.width,
          height: dec.height,
          addedAt: Date.now(),
          original: file, // the untouched original bytes
          thumbnail,
        };
        await this.db.putPhoto(rec);
        this.records.set(rec.id, rec);
        this.set({ photos: [...this.state.photos, this.summarize(rec)] });
        lastId = rec.id;
      } catch (e) {
        this.toast(e instanceof Error ? e.message : String(e));
      }
    }
    this.set({ loading: false });
    if (lastId) await this.select(lastId);
  }

  async removePhoto(id: string) {
    await this.db.deletePhoto(id);
    this.records.delete(id);
    this.histories.delete(id);
    const photos = this.state.photos.filter((p) => p.id !== id);
    this.set({ photos });
    if (this.state.currentId === id) {
      this.state.image?.bitmap.close();
      this.set({ currentId: null, image: null, history: null, params: DEFAULT_PARAMS, canUndo: false, canRedo: false });
      if (photos[0]) await this.select(photos[0].id);
    }
  }

  async select(id: string) {
    if (id === this.state.currentId) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); await this.saveNow(); }
    const token = ++this.loadToken;
    const rec = this.records.get(id);
    if (!rec) return;
    this.set({ loading: true });
    try {
      const dec = await decodeFile(new File([rec.original], rec.name, { type: rec.type }), PREVIEW_MAX_DIM);
      if (token !== this.loadToken) { dec.bitmap.close(); return; }
      let h = this.histories.get(id);
      if (!h) {
        const saved = await this.db.getEdits(id);
        h = createHistory(normalizeParams(saved?.edits), saved ? 'Saved edits' : 'Original');
        this.histories.set(id, h);
      }
      const analysis = makeAnalysisImage(dec.bitmap);
      this.state.image?.bitmap.close();
      this.set({
        currentId: id,
        image: { photoId: id, bitmap: dec.bitmap, analysis },
        history: h,
        params: present(h),
        canUndo: canUndo(h),
        canRedo: canRedo(h),
        showOriginal: false,
        eyedropper: false,
        loading: false,
      });
      void this.db.setMeta('lastPhotoId', id);
    } catch (e) {
      this.set({ loading: false });
      this.toast(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- editing (all go through history snapshots of EditParams)
  private h(): EditHistory | null {
    return this.state.history;
  }
  previewParam = (key: ParamKey, value: number) => { const h = this.h(); if (h) this.setHistory(previewParam(h, key, value), false); };
  commitParam = (key: ParamKey, coalesce = false) => { const h = this.h(); if (h) this.setHistory(commitParam(h, key, coalesce)); };
  setParam = (key: ParamKey, value: number, coalesce = false) => { this.previewParam(key, value); this.commitParam(key, coalesce); };
  resetParam = (key: ParamKey) => { const h = this.h(); if (h) this.setHistory(resetParam(h, key)); };
  resetSection = (s: SectionId) => { const h = this.h(); if (h) this.setHistory(resetSection(h, s)); };
  resetAll = () => { const h = this.h(); if (h) this.setHistory(resetAll(h)); };
  undo = () => { const h = this.h(); if (h) this.setHistory(undo(h)); };
  redo = () => { const h = this.h(); if (h) this.setHistory(redo(h)); };
  jumpTo = (i: number) => { const h = this.h(); if (h) this.setHistory(jumpTo(h, i)); };

  toggleOriginal = (v?: boolean) => this.set({ showOriginal: v ?? !this.state.showOriginal });
  toggleClipping = () => this.set({ showClipping: !this.state.showClipping });
  toggleEyedropper = (v?: boolean) => this.set({ eyedropper: v ?? !this.state.eyedropper });

  autoWhiteBalance = () => {
    const h = this.h(); const img = this.state.image;
    if (!h || !img) return;
    const wb = autoWhiteBalance(img.analysis);
    if (!wb) return this.toast('Auto white balance: not enough mid-tone pixels to estimate from.');
    this.setHistory(setParams(h, { temperature: Math.round(wb.temperature), tint: Math.round(wb.tint) }, 'Auto White Balance'));
  };

  /** Eyedropper: make the clicked point neutral. (u,v) normalised image coords. */
  pickWhiteBalance = (u: number, v: number) => {
    const h = this.h(); const img = this.state.image;
    if (!h || !img) return;
    const wb = solveWhiteBalance(sampleLinear(img.analysis, u, v));
    this.setHistory(setParams(h, { temperature: Math.round(wb.temperature), tint: Math.round(wb.tint) }, 'White Balance Picker'));
    this.set({ eyedropper: false });
  };

  isEdited = () => !paramsEqual(this.state.params, DEFAULT_PARAMS);
}

export const store = new EditorStore(new IndexedDbPhotoStore());

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
