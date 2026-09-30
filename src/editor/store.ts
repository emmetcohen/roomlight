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
import type { CurveChannel, CurvePoint } from '../image-engine/curves';
import { DEFAULT_PARAMS, isDefault, normalizeParams, type EditParams, type ParamKey, type SectionId } from '../image-engine/params';
import { canRedo, canUndo, createHistory, jumpTo, present, redo, undo } from '../history/history';
import { applyEdit, commitCurve, commitLabel, commitParam, previewCurve, previewEdit, previewParam, previewPatch, resetAll, resetCurve, resetKeys, resetParam, resetSection, setParams, type EditCtx, type EditHistory, type ParamPatch } from '../history/editActions';
import { cropIsValid, flip as flipCrop, resetCropTool, rotate90 as rotateCrop, setAspect, straightenFromLine, swapAspectOrientation } from '../geometry/cropActions';
import type { AspectPreset, Crop } from '../geometry/crop';
import { geoOf, makeGeoMap, outputSize, outputToSource } from '../geometry/transform';
import { edgeSamples, estimateUpright, grayFromRgba, type UprightMode } from '../geometry/upright';
import { getLensProfile } from '../lens/profiles';

import * as MaskOps from '../masks/ops';
import { firstAvailableProvider, setSegmentRaster } from '../masks/segmentation';
import { SHAPE_LABEL, newComponent, newMask, newShape, spanOf, type BrushStroke, type LocalKey, type Mask, type MaskComponent, type MaskOp, type Shape } from '../masks/types';
import { linearToOklab } from '../image-engine/oklab';
import { srgbToLinear } from '../color/colorSpace';
import { decodeFile } from '../import/decoders';
import { makeThumbnail } from '../library/thumbnail';
import { findSource } from '../retouch/apply';
import * as SpotOps from '../retouch/ops';
import { readPixels, retouchedPixels, type Pixels } from '../retouch/source';
import { SPOT_KIND_LABEL, newSpot, type Spot, type SpotKind } from '../retouch/types';
import { EDIT_SCHEMA_VERSION, IndexedDbPhotoStore, type PhotoRecord, type PhotoStore, type PresetRecord } from '../storage/db';
import { NO_FILTER, defaultInfo, normalizeInfo, type AlbumRecord, type ColorLabel, type Flag, type LibraryFilter, type PhotoInfo, type SortKey } from '../library/types';
import { queryPhotos } from '../library/query';
import { readExif } from '../metadata/readExif';
import { BUILTIN_PRESETS, type Preset } from '../presets/builtin';
import { DEFAULT_GROUPS, type GroupId } from '../presets/groups';
import { applyPreset, extractPreset, sanitizePreset, type PresetData } from '../presets/snapshot';
import { autoTone } from '../image-engine/autoTone';
import { runExport, saveBlob, zipStore } from '../export/client';
import { DEFAULT_EXPORT, formatFilename, normalizeExport, resolveSize, uniqueNames, type ExportSettings } from '../export/types';

/** Long edge of the working preview. Full-resolution rendering is an export-phase concern. */
export const PREVIEW_MAX_DIM = 2560;

export interface PhotoSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  size: number;
  addedAt: number;
  thumbUrl: string | null;
  info: PhotoInfo;
  /** Has non-default edits. */
  edited: boolean;
}

/** Zoom: z = device pixels per image pixel (1 = 100 %), null = fit to window. (cx, cy) = centre of the view in output uv. */
export interface ZoomState { z: number | null; cx: number; cy: number }
export const MAX_ZOOM = 4;

/** The original decoded at (up to) full size, loaded only while zoomed in. */
export interface FullRes { photoId: string; bitmap: ImageBitmap }

export interface ExportStatus { done: number; total: number; stage: string; name: string }
export interface ExportSummary { files: number; bytes: number; notes: string[]; ranIn: 'worker' | 'main' | 'mixed'; zip: boolean; cancelled: boolean; names: string[]; size: string }

export interface SettingsClipboard { groups: GroupId[]; data: PresetData; from: string }

export interface LoadedImage {
  photoId: string;
  bitmap: ImageBitmap;
  analysis: AnalysisImage;
  /** RGBA8 of the decoded original (input to retouching). Never modified. */
  pixels: Pixels;
}

export type Tool = 'edit' | 'crop' | 'mask' | 'retouch';
export type Mode = 'library' | 'edit';
export type CropTab = 'crop' | 'geometry';
export type CropGuides = 'none' | 'thirds' | 'grid';
export type DialogId = 'copy' | 'paste' | 'savePreset' | 'export';

export interface RetouchSettings {
  kind: SpotKind;
  size: number; // 1..100
  feather: number; // 0..100
  opacity: number; // 1..100
}

export interface BrushSettings {
  size: number; // 1..100
  feather: number; // 0..100
  flow: number; // 1..100
  density: number; // 1..100
  erase: boolean;
}
/** Brush size slider -> radius in mask space (fraction of the long edge). */
export const brushRadius = (size: number) => 0.004 + 0.15 * (size / 100) ** 2;

export interface EditorState {
  mode: Mode;
  tool: Tool;
  cropTab: CropTab;
  cropGuides: CropGuides;
  straightenTool: boolean;
  constrainCrop: boolean;
  cropEntryIndex: number | null;
  selectedMask: string | null;
  selectedComp: string | null;
  selectedSpot: string | null;
  retouch: RetouchSettings;
  brush: BrushSettings;
  showOverlay: boolean;
  pickingColor: boolean;
  ready: boolean;
  photos: PhotoSummary[];
  /** Ids of the photos that pass the filter, in display order. */
  visible: string[];
  albums: AlbumRecord[];
  userPresets: PresetRecord[];
  filter: LibraryFilter;
  sort: SortKey;
  sortDesc: boolean;
  /** Multi-selection in the filmstrip (empty = just the open photo). */
  selection: string[];
  clipboard: SettingsClipboard | null;
  dialog: DialogId | null;
  exportSettings: ExportSettings;
  zoom: ZoomState;
  /** Incremented by the Z shortcut; the viewer (which knows the fit scale) performs the toggle. */
  zoomToggle: number;
  fullRes: FullRes | null;
  fullResLoading: boolean;
  exportScope: 'open' | 'selected' | 'shown';
  exportStatus: ExportStatus | null;
  exportSummary: ExportSummary | null;
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
  mode: 'edit',
  tool: 'edit',
  cropTab: 'crop',
  cropGuides: 'thirds',
  straightenTool: false,
  constrainCrop: true,
  cropEntryIndex: null,
  selectedMask: null,
  selectedComp: null,
  selectedSpot: null,
  retouch: { kind: 'heal', size: 30, feather: 40, opacity: 100 },
  brush: { size: 40, feather: 50, flow: 100, density: 100, erase: false },
  showOverlay: true,
  pickingColor: false,
  ready: false,
  photos: [],
  visible: [],
  albums: [],
  userPresets: [],
  filter: NO_FILTER,
  sort: 'added',
  sortDesc: false,
  selection: [],
  clipboard: null,
  dialog: null,
  exportSettings: DEFAULT_EXPORT,
  zoom: { z: null, cx: 0.5, cy: 0.5 },
  zoomToggle: 0,
  fullRes: null,
  fullResLoading: false,
  exportScope: 'open',
  exportStatus: null,
  exportSummary: null,
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
    this.markEdited(id, present(h));
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

  toast(msg: string) {
    this.set({ messages: [...this.state.messages, msg].slice(-4) });
  }
  dismissMessage = (i: number) => this.set({ messages: this.state.messages.filter((_, j) => j !== i) });

  // ---- library
  async init() {
    const [records, infos, edits, albums, userPresets] = await Promise.all([this.db.listPhotos(), this.db.listInfo(), this.db.listEdits(), this.db.listAlbums(), this.db.listPresets()]);
    const infoBy = new Map(infos.map((i) => [i.photoId, normalizeInfo(i, i.photoId)]));
    const editedBy = new Map(edits.map((e) => [e.photoId, !isDefault(normalizeParams(e.edits))]));
    const photos: PhotoSummary[] = [];
    for (const r of records) {
      this.records.set(r.id, r);
      photos.push(this.summarize(r, infoBy.get(r.id) ?? defaultInfo(r.id), editedBy.get(r.id) ?? false));
    }
    this.setPhotos(photos, { albums, userPresets, exportSettings: normalizeExport(await this.db.getMeta('exportSettings')) });
    this.set({ ready: true });
    void this.backfillInfo();
    const last = await this.db.getMeta<string>('lastPhotoId');
    const pick = photos.find((p) => p.id === last) ?? photos[0];
    if (pick) await this.select(pick.id);
  }

  private summarize(r: PhotoRecord, info: PhotoInfo, edited = false): PhotoSummary {
    return { id: r.id, name: r.name, width: r.width, height: r.height, size: r.size, addedAt: r.addedAt, thumbUrl: r.thumbnail ? URL.createObjectURL(r.thumbnail) : null, info, edited };
  }

  /** Replace the photo list (and optionally albums/presets) and recompute what is visible. */
  private setPhotos(photos: PhotoSummary[], extra: Partial<EditorState> = {}) {
    const f = { filter: this.state.filter, sort: this.state.sort, sortDesc: this.state.sortDesc, ...extra };
    const visible = queryPhotos(photos, f.filter, f.sort, f.sortDesc).map((p) => p.id);
    const keep = new Set(photos.map((p) => p.id));
    this.set({ photos, visible, selection: this.state.selection.filter((id) => keep.has(id)), ...extra });
  }

  /** Photos imported before library metadata existed: read their EXIF quietly in the background. */
  private async backfillInfo() {
    for (const p of this.state.photos) {
      if (p.info.exif !== undefined) continue;
      const rec = this.records.get(p.id);
      if (!rec) continue;
      const exif = await readExif(rec.original, rec.type, rec.name);
      this.patchInfo(p.id, { exif });
    }
  }

  private markEdited(id: string, params: EditParams) {
    const edited = !isDefault(params);
    const cur = this.state.photos.find((p) => p.id === id);
    if (!cur || cur.edited === edited) return;
    this.setPhotos(this.state.photos.map((p) => (p.id === id ? { ...p, edited } : p)));
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
        const info: PhotoInfo = { ...defaultInfo(rec.id), exif: await readExif(file, file.type, file.name) };
        await this.db.putInfo(info);
        this.records.set(rec.id, rec);
        this.setPhotos([...this.state.photos, this.summarize(rec, info)]);
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
    this.setPhotos(photos);
    if (this.state.currentId === id) {
      this.state.image?.bitmap.close();
      this.set({ currentId: null, image: null, history: null, params: DEFAULT_PARAMS, canUndo: false, canRedo: false });
      const next = this.state.visible[0] ?? photos[0]?.id;
      if (next) await this.select(next);
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
      const pixels = readPixels(dec.bitmap);
      this.state.image?.bitmap.close();
      this.state.fullRes?.bitmap.close();
      this.set({
        currentId: id,
        image: { photoId: id, bitmap: dec.bitmap, analysis, pixels },
        history: h,
        params: present(h),
        canUndo: canUndo(h),
        canRedo: canRedo(h),
        showOriginal: false,
        eyedropper: false,
        loading: false,
        tool: 'edit',
        selectedMask: null,
        selectedComp: null,
        selectedSpot: null,
        pickingColor: false,
        zoom: { z: null, cx: 0.5, cy: 0.5 },
        fullRes: null,
        fullResLoading: false,
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
  /** Source width/height, so geometry edits can keep the crop inside the picture. */
  private ctx(): EditCtx | undefined {
    const b = this.state.image?.bitmap;
    return b ? { aspect: b.width / b.height, constrain: this.state.constrainCrop } : undefined;
  }
  previewParam = (key: ParamKey, value: number) => { const h = this.h(); if (h) this.setHistory(previewParam(h, key, value, this.ctx()), false); };
  commitParam = (key: ParamKey, coalesce = false) => { const h = this.h(); if (h) this.setHistory(commitParam(h, key, coalesce)); };
  setParam = (key: ParamKey, value: number, coalesce = false) => { this.previewParam(key, value); this.commitParam(key, coalesce); };
  /** Multi-parameter gesture (e.g. a colour wheel sets hue + saturation together). */
  previewPatch = (patch: ParamPatch) => { const h = this.h(); if (h) this.setHistory(previewPatch(h, patch, this.ctx()), false); };
  commitPatch = (label: string) => { const h = this.h(); if (h) this.setHistory(commitLabel(h, label)); };
  resetKeys = (keys: ParamKey[], label: string) => { const h = this.h(); if (h) this.setHistory(resetKeys(h, keys, label, this.ctx())); };
  previewCurve = (ch: CurveChannel, pts: CurvePoint[]) => { const h = this.h(); if (h) this.setHistory(previewCurve(h, ch, pts), false); };
  commitCurve = (ch: CurveChannel) => { const h = this.h(); if (h) this.setHistory(commitCurve(h, ch)); };
  resetCurve = (ch: CurveChannel | 'all') => { const h = this.h(); if (h) this.setHistory(resetCurve(h, ch)); };
  resetParam = (key: ParamKey) => { const h = this.h(); if (h) this.setHistory(resetParam(h, key, this.ctx())); };
  resetSection = (s: SectionId) => { const h = this.h(); if (h) this.setHistory(resetSection(h, s)); };
  resetAll = () => { const h = this.h(); if (h) this.setHistory(resetAll(h)); };
  undo = () => { const h = this.h(); if (h) this.setHistory(undo(h)); };
  redo = () => { const h = this.h(); if (h) this.setHistory(redo(h)); };
  jumpTo = (i: number) => { const h = this.h(); if (h) this.setHistory(jumpTo(h, i)); };


  // ---------------------------------------------------------------- zoom / pan / full resolution
  setZoom = (zoom: ZoomState) => this.set({ zoom: { z: zoom.z === null ? null : Math.min(MAX_ZOOM, Math.max(0.02, zoom.z)), cx: zoom.cx, cy: zoom.cy } });
  toggleZoom = () => this.set({ zoomToggle: this.state.zoomToggle + 1 });
  zoomFit = () => this.setZoom({ z: null, cx: 0.5, cy: 0.5 });
  private fullToken = 0;
  /** Decode the original at up to `maxDim` (the GPU's texture limit) for 1:1 viewing. No-op when already loaded or unnecessary. */
  ensureFullRes = async (maxDim: number) => {
    const id = this.state.currentId, rec = id ? this.records.get(id) : null;
    if (!id || !rec || this.state.fullRes?.photoId === id || this.state.fullResLoading) return;
    const token = ++this.fullToken;
    this.set({ fullResLoading: true });
    try {
      const dec = await decodeFile(new File([rec.original], rec.name, { type: rec.type }), maxDim);
      if (token !== this.fullToken || this.state.currentId !== id) { dec.bitmap.close(); return; }
      this.set({ fullRes: { photoId: id, bitmap: dec.bitmap }, fullResLoading: false });
    } catch (e) {
      this.set({ fullResLoading: false });
      this.toast(`Could not load the full-resolution image: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  releaseFullRes = () => {
    this.fullToken++;
    const f = this.state.fullRes;
    if (f) { f.bitmap.close(); this.set({ fullRes: null, fullResLoading: false }); } else if (this.state.fullResLoading) this.set({ fullResLoading: false });
  };

  // ---------------------------------------------------------------- tools
  openDialog = (dialog: DialogId) => { if (this.state.currentId) this.set({ dialog, ...(dialog === 'export' ? { exportSummary: null, exportScope: this.state.selection.length > 1 ? 'selected' as const : 'open' as const } : {}) }); };
  closeDialog = () => this.set({ dialog: null });
  setMode = (mode: Mode) => { if (mode === 'edit' && !this.state.currentId) return; this.set({ mode, dialog: null }); };
  /** Library: open a photo in the Edit view. */
  openInEdit = async (id: string) => { await this.select(id); this.set({ mode: 'edit' }); };
  setTool = (tool: Tool) => {
    const entering = tool === 'crop' && this.state.tool !== 'crop';
    const h = this.state.history;
    this.set({ tool, eyedropper: false, pickingColor: false, straightenTool: false, ...(entering ? { cropEntryIndex: h ? h.index : null, cropTab: 'crop' as const } : {}) });
  };
  setCropTab = (cropTab: CropTab) => this.set({ cropTab, straightenTool: false });
  setCropGuides = (cropGuides: CropGuides) => this.set({ cropGuides });
  setConstrainCrop = (constrainCrop: boolean) => this.set({ constrainCrop });
  toggleStraightenTool = () => this.set({ straightenTool: !this.state.straightenTool });
  /** Cancel in the Crop & Geometry tool: rewind to how the photo was when the tool was opened, then leave. */
  cancelCrop = () => {
    const h = this.h(), idx = this.state.cropEntryIndex;
    if (h && idx !== null && idx < h.entries.length) this.setHistory(jumpTo(h, idx));
    this.set({ tool: 'edit', straightenTool: false });
  };
  /** Straighten tool: a line drawn on the displayed picture (overlay pixels) becomes level / plumb. */
  straightenLine = (x1: number, y1: number, x2: number, y2: number) => {
    const h = this.h();
    if (!h) return;
    const a = straightenFromLine(this.state.params.straighten, x1, y1, x2, y2);
    this.set({ straightenTool: false });
    if (a === null) return this.toast('That line is too short to straighten from. Draw a longer one along the horizon or an edge.');
    this.setHistory(setParams(h, { straighten: a }, 'Straighten', this.ctx()));
  };

  // ---------------------------------------------------------------- crop / geometry
  private applyParamsEdit(fn: (p: EditParams) => EditParams, label: string) { const h = this.h(); if (h) this.setHistory(applyEdit(h, fn, label)); }
  previewCrop = (crop: Crop) => { const h = this.h(); if (h) this.setHistory(previewEdit(h, (p) => ({ ...p, crop })), false); };
  commitCrop = () => { const h = this.h(); if (h) this.setHistory(commitLabel(h, 'Crop')); };
  /** True if `crop` reads only from inside the original under the current geometry. */
  cropValid = (crop: Crop) => { const c = this.ctx(); return !c || cropIsValid(this.state.params, c.aspect, crop); };
  setAspectPreset = (preset: AspectPreset, custom?: { w: number; h: number }) => { const c = this.ctx(); if (c) this.applyParamsEdit((p) => setAspect(p, preset, c.aspect, custom), 'Crop Aspect'); };
  swapAspect = () => { const c = this.ctx(); if (c) this.applyParamsEdit((p) => swapAspectOrientation(p, c.aspect), 'Crop Orientation'); };
  rotate90 = (dir: 1 | -1) => this.applyParamsEdit((p) => rotateCrop(p, dir), dir === 1 ? 'Rotate Right' : 'Rotate Left');
  flip = (axis: 'h' | 'v') => this.applyParamsEdit((p) => flipCrop(p, axis), axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical');
  resetCropTool = () => this.applyParamsEdit(resetCropTool, 'Reset Crop');
  setLensProfile = (id: string) => this.applyParamsEdit((p) => ({ ...p, lensProfile: id }), id === 'none' ? 'Lens Profile Off' : `Lens Profile: ${getLensProfile(id)?.name ?? id}`);

  /** Automatic perspective correction from detected straight edges. Says so when it finds none. */
  autoUpright = (mode: UprightMode) => {
    const img = this.state.image, h = this.h();
    if (!img || !h) return;
    const { width, height, data } = img.analysis;
    const est = estimateUpright(edgeSamples(grayFromRgba(data, width, height), width, height), width, height, geoOf(this.state.params), mode);
    if (!est) return this.toast('Auto upright: no clear straight lines were found in this photo, so nothing was changed.');
    const label = { level: 'Auto Level', vertical: 'Auto Vertical', auto: 'Auto Upright', full: 'Auto Upright (Full)' }[mode];
    this.setHistory(setParams(h, est, label, this.ctx()));
  };

  // ---------------------------------------------------------------- masks
  private masksEdit(fn: (m: Mask[]) => Mask[], label: string) { this.applyParamsEdit((p) => ({ ...p, masks: fn(p.masks) }), label); }
  private imageSpan() { const b = this.state.image?.bitmap; return b ? spanOf(b.width, b.height) : { hw: 0.5, hh: 0.375 }; }
  selectMask = (id: string | null, comp?: string | null) => {
    const m = this.state.params.masks.find((x) => x.id === id);
    this.set({ selectedMask: m ? id : null, selectedComp: m ? (comp ?? m.components[0]?.id ?? null) : null, pickingColor: false });
  };
  selectComp = (maskId: string, compId: string) => this.set({ selectedMask: maskId, selectedComp: compId, pickingColor: false });
  setBrush = (patch: Partial<BrushSettings>) => this.set({ brush: { ...this.state.brush, ...patch } });
  toggleOverlay = () => this.set({ showOverlay: !this.state.showOverlay });

  /** Create a new mask from a shape. Explains why when a limit is hit. */
  createMask = (type: Shape['type']) => {
    const masks = this.state.params.masks;
    const shape = newShape(type, this.imageSpan());
    const why = MaskOps.limitReason(masks, shape, true);
    if (why) return this.toast(why);
    const mask = newMask(shape, `${SHAPE_LABEL[type]} ${masks.length + 1}`);
    this.masksEdit((m) => MaskOps.addMask(m, mask), `Add ${SHAPE_LABEL[type]}`);
    this.set({ selectedMask: mask.id, selectedComp: mask.components[0].id, tool: 'mask', pickingColor: type === 'color' });
  };
  addComponent = (type: Shape['type'], op: MaskOp) => {
    const id = this.state.selectedMask;
    const mask = this.state.params.masks.find((m) => m.id === id);
    if (!id || !mask) return;
    const shape = newShape(type, this.imageSpan());
    const why = MaskOps.limitReason(this.state.params.masks, shape, false);
    if (why) return this.toast(why);
    const comp = newComponent(shape, op);
    this.masksEdit((m) => MaskOps.addComponent(m, id, comp), `${op === 'add' ? 'Add' : op === 'subtract' ? 'Subtract' : 'Intersect'} ${SHAPE_LABEL[type]}`);
    this.set({ selectedComp: comp.id, pickingColor: type === 'color' });
  };
  removeMask = (id: string) => {
    this.masksEdit((m) => MaskOps.removeMask(m, id), 'Delete Mask');
    if (this.state.selectedMask === id) this.set({ selectedMask: null, selectedComp: null });
  };
  removeComponent = (maskId: string, compId: string) => {
    this.masksEdit((m) => MaskOps.removeComponent(m, maskId, compId), 'Delete Mask Component');
    const m = this.state.params.masks.find((x) => x.id === maskId);
    this.set({ selectedComp: m?.components[0]?.id ?? null, selectedMask: m ? maskId : null });
  };
  duplicateMask = (id: string) => this.masksEdit((m) => MaskOps.duplicateMask(m, id), 'Duplicate Mask');
  updateMaskMeta = (id: string, patch: Partial<Pick<Mask, 'name' | 'enabled' | 'invert' | 'amount'>>, label: string) =>
    this.masksEdit((m) => MaskOps.updateMask(m, id, (x) => ({ ...x, ...patch })), label);
  previewMaskMeta = (id: string, patch: Partial<Pick<Mask, 'amount'>>) => { const h = this.h(); if (h) this.setHistory(previewEdit(h, (p) => ({ ...p, masks: MaskOps.updateMask(p.masks, id, (x) => ({ ...x, ...patch })) })), false); };
  setComponentMeta = (maskId: string, compId: string, patch: Partial<Pick<MaskComponent, 'op' | 'invert'>>, label: string) =>
    this.masksEdit((m) => MaskOps.updateComponent(m, maskId, compId, (c) => ({ ...c, ...patch })), label);

  previewLocal = (maskId: string, key: LocalKey, value: number) => { const h = this.h(); if (h) this.setHistory(previewEdit(h, (p) => ({ ...p, masks: MaskOps.setAdjust(p.masks, maskId, key, value) })), false); };
  commitLocal = (label: string) => { const h = this.h(); if (h) this.setHistory(commitLabel(h, label)); };
  setLocal = (maskId: string, key: LocalKey, value: number, label: string) => { this.previewLocal(maskId, key, value); this.commitLocal(label); };

  previewShape = (maskId: string, compId: string, fn: (s: Shape) => Shape) => { const h = this.h(); if (h) this.setHistory(previewEdit(h, (p) => ({ ...p, masks: MaskOps.updateShape(p.masks, maskId, compId, fn) })), false); };
  commitShape = (label: string) => { const h = this.h(); if (h) this.setHistory(commitLabel(h, label)); };

  // brush painting: one pointer gesture = one stroke = one history entry
  beginStroke = (x: number, y: number, pressure = 1) => {
    const { selectedMask: m, selectedComp: c, brush } = this.state;
    if (!m || !c) return;
    const stroke: BrushStroke = { points: [{ x, y, p: pressure }], radius: brushRadius(brush.size), feather: brush.feather / 100, flow: brush.flow / 100, density: brush.density / 100, erase: brush.erase };
    this.previewShape(m, c, (s) => (s.type === 'brush' ? { ...s, strokes: [...s.strokes, stroke] } : s));
  };
  extendStroke = (x: number, y: number, pressure = 1) => {
    const { selectedMask: m, selectedComp: c } = this.state;
    if (!m || !c) return;
    this.previewShape(m, c, (s) => {
      if (s.type !== 'brush' || !s.strokes.length) return s;
      const last = s.strokes[s.strokes.length - 1];
      const lp = last.points[last.points.length - 1];
      if (Math.hypot(lp.x - x, lp.y - y) < last.radius * 0.08) return s; // skip jitter: keeps strokes compact
      return { ...s, strokes: [...s.strokes.slice(0, -1), { ...last, points: [...last.points, { x, y, p: pressure }] }] };
    });
  };
  endStroke = () => this.commitShape(this.state.brush.erase ? 'Erase Brush Stroke' : 'Brush Stroke');

  setPickingColor = (v: boolean) => this.set({ pickingColor: v });
  resetMaskAdjust = (maskId: string) => this.masksEdit((m) => MaskOps.updateMask(m, maskId, (x) => ({ ...x, adjust: {} })), 'Reset Mask Adjustments');

  /** Subject / Sky / Background: only works when a segmentation provider is registered (none ships). */
  createSegmentMask = async (kind: 'subject' | 'sky' | 'background') => {
    const provider = await firstAvailableProvider();
    const img = this.state.image;
    if (!provider || !img) return this.toast('Selection by AI is unavailable: no segmentation model is installed.');
    const shape: Shape = { type: 'segment', kind };
    const why = MaskOps.limitReason(this.state.params.masks, shape, true);
    if (why) return this.toast(why);
    try {
      const raster = await provider.segment(img.bitmap, kind);
      const mask = newMask(shape, `${kind[0].toUpperCase()}${kind.slice(1)}`);
      setSegmentRaster(mask.components[0].id, raster);
      this.masksEdit((m) => MaskOps.addMask(m, mask), `Select ${kind}`);
      this.set({ selectedMask: mask.id, selectedComp: mask.components[0].id });
    } catch (e) {
      this.toast(`Selection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Colour-range eyedropper: sample the ORIGINAL at an output position (u, v in 0..1 of the displayed picture). */
  pickMaskColor = (u: number, v: number) => {
    const { image, selectedMask: m, selectedComp: c } = this.state;
    if (!image || !m || !c) return;
    const p = this.state.params, b = image.bitmap;
    const src = outputToSource(makeGeoMap(p, b.width, b.height), u, v);
    if (!src) return;
    const su = Math.min(1, Math.max(0, src[0] / b.width + 0.5)), sv = Math.min(1, Math.max(0, src[1] / b.height + 0.5));
    const a = image.analysis;
    const cx = Math.round(su * (a.width - 1)), cy = Math.round(sv * (a.height - 1));
    let r = 0, g = 0, bl = 0, n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(a.height - 1, cy + 2); y++) for (let x = Math.max(0, cx - 2); x <= Math.min(a.width - 1, cx + 2); x++) {
      const i = (y * a.width + x) * 4; r += srgbToLinear(a.data[i] / 255); g += srgbToLinear(a.data[i + 1] / 255); bl += srgbToLinear(a.data[i + 2] / 255); n++;
    }
    const [L, A, B] = linearToOklab([r / n, g / n, bl / n]);
    this.previewShape(m, c, (s) => (s.type === 'color' ? { ...s, L, a: A, b: B } : s));
    this.commitShape('Pick Mask Color');
    this.set({ pickingColor: false });
  };


  // ---------------------------------------------------------------- retouch (clone / heal / remove)
  private spotsEdit(fn: (s: Spot[]) => Spot[], label: string) { this.applyParamsEdit((p) => ({ ...p, spots: fn(p.spots) }), label); }
  setRetouch = (patch: Partial<RetouchSettings>) => {
    this.set({ retouch: { ...this.state.retouch, ...patch } });
    // changing the mode / size controls of a selected spot edits that spot
    const sel = this.state.selectedSpot;
    if (sel && (patch.kind || patch.size !== undefined || patch.feather !== undefined || patch.opacity !== undefined)) {
      const r = this.state.retouch;
      this.previewSpot(sel, (s) => ({ ...s, kind: r.kind, r: SpotOps.spotRadius(r.size), feather: r.feather / 100, opacity: r.opacity / 100 }));
      this.commitSpot(patch.kind ? `Spot: ${SPOT_KIND_LABEL[r.kind]}` : 'Adjust Spot', !patch.kind);
    }
  };
  previewRetouchControl = (key: 'size' | 'feather' | 'opacity', v: number) => {
    const r = { ...this.state.retouch, [key]: v };
    this.set({ retouch: r });
    const sel = this.state.selectedSpot;
    if (sel) this.previewSpot(sel, (s) => ({ ...s, r: SpotOps.spotRadius(r.size), feather: r.feather / 100, opacity: r.opacity / 100 }));
  };
  commitRetouchControl = () => { if (this.state.selectedSpot) this.commitSpot('Adjust Spot'); };
  selectSpot = (id: string | null) => {
    const sp = this.state.params.spots.find((x) => x.id === id);
    if (sp) this.set({ selectedSpot: sp.id, retouch: { kind: sp.kind, size: SpotOps.sizeOfRadius(sp.r), feather: Math.round(sp.feather * 100), opacity: Math.round(sp.opacity * 100) } });
    else this.set({ selectedSpot: null });
  };
  /** Source centre (mask space) for a new spot at (x, y): the best-matching nearby patch, else a fixed offset. */
  private suggestSource(x: number, y: number, r: number): { sx: number; sy: number } {
    const img = this.state.image;
    if (!img) return { sx: x + r * 3, sy: y };
    const { width: w, height: h } = img.pixels, L = Math.max(w, h);
    const f = findSource({ data: img.pixels.data, w, h }, w / 2 + x * L, h / 2 + y * L, Math.max(0.75, r * L));
    if (f) return { sx: (f.x - w / 2) / L, sy: (f.y - h / 2) / L };
    const sx = x + r * 3.2, hw = w / L / 2;
    return { sx: sx > hw ? x - r * 3.2 : sx, sy: y };
  }
  /** Click-to-add. (x, y) in mask space. */
  addSpotAt = (x: number, y: number) => {
    const why = SpotOps.limitReason(this.state.params.spots);
    if (why) return this.toast(why);
    const r = this.state.retouch;
    const radius = SpotOps.spotRadius(r.size);
    const spot = newSpot(r.kind, x, y, radius, this.suggestSource(x, y, radius), r.feather / 100, r.opacity / 100);
    this.spotsEdit((s) => SpotOps.addSpot(s, spot), `Add ${SPOT_KIND_LABEL[r.kind]} Spot`);
    this.set({ selectedSpot: spot.id });
  };
  previewSpot = (id: string, fn: (s: Spot) => Spot) => { const h = this.h(); if (h) this.setHistory(previewEdit(h, (p) => ({ ...p, spots: SpotOps.updateSpot(p.spots, id, fn) })), false); };
  commitSpot = (label: string, coalesce = false) => { const h = this.h(); if (h) this.setHistory(commitLabel(h, label, coalesce ? `spot:${label}` : undefined)); };
  setSpotEnabled = (id: string, enabled: boolean) => this.spotsEdit((s) => SpotOps.updateSpot(s, id, (x) => ({ ...x, enabled })), enabled ? 'Enable Spot' : 'Disable Spot');
  removeSpot = (id: string) => {
    this.spotsEdit((s) => SpotOps.removeSpot(s, id), 'Delete Spot');
    if (this.state.selectedSpot === id) this.set({ selectedSpot: null });
  };
  clearSpots = () => { this.spotsEdit(() => [], 'Clear Spots'); this.set({ selectedSpot: null }); };
  /** Where each spot's pixels come from right now (auto-found for Remove). For the overlay. */
  spotSources = () => {
    const img = this.state.image;
    return img ? retouchedPixels(img.pixels, this.state.params.spots).resolved : new Map();
  };


  // ---------------------------------------------------------------- library: info, ratings, albums, filters
  /** Photos an action applies to: the multi-selection, or just the open photo. */
  targets = (): string[] => (this.state.selection.length ? this.state.selection : this.state.currentId ? [this.state.currentId] : []);

  private patchInfo(id: string, patch: Partial<PhotoInfo>) {
    const cur = this.state.photos.find((p) => p.id === id);
    if (!cur) return;
    const info = normalizeInfo({ ...cur.info, ...patch }, id);
    this.setPhotos(this.state.photos.map((p) => (p.id === id ? { ...p, info } : p)));
    void this.db.putInfo(info);
  }
  updateInfo = (id: string, patch: Partial<PhotoInfo>) => this.patchInfo(id, patch);

  /** Setting the value a photo already has clears it (press 3 twice → unrated), like most photo managers. */
  setRating = (n: number, ids = this.targets()) => {
    const all = ids.every((id) => this.state.photos.find((p) => p.id === id)?.info.rating === n);
    for (const id of ids) this.patchInfo(id, { rating: all ? 0 : n });
  };
  setFlag = (f: Flag, ids = this.targets()) => {
    const all = ids.every((id) => this.state.photos.find((p) => p.id === id)?.info.flag === f);
    for (const id of ids) this.patchInfo(id, { flag: all ? 'none' : f });
  };
  setLabel = (l: ColorLabel | null, ids = this.targets()) => {
    const all = l !== null && ids.every((id) => this.state.photos.find((p) => p.id === id)?.info.label === l);
    for (const id of ids) this.patchInfo(id, { label: all ? null : l });
  };

  // albums
  createAlbum = async (name: string): Promise<string | null> => {
    const n = name.trim();
    if (!n) return null;
    const a: AlbumRecord = { id: crypto.randomUUID(), name: n, createdAt: Date.now() };
    await this.db.putAlbum(a);
    this.set({ albums: [...this.state.albums, a] });
    return a.id;
  };
  renameAlbum = async (id: string, name: string) => {
    const a = this.state.albums.find((x) => x.id === id), n = name.trim();
    if (!a || !n) return;
    const next = { ...a, name: n };
    await this.db.putAlbum(next);
    this.set({ albums: this.state.albums.map((x) => (x.id === id ? next : x)) });
  };
  deleteAlbum = async (id: string) => {
    await this.db.deleteAlbum(id);
    const f = this.state.filter.albumId === id ? { ...this.state.filter, albumId: null } : this.state.filter;
    for (const p of this.state.photos) if (p.info.albumIds.includes(id)) this.patchInfo(p.id, { albumIds: p.info.albumIds.filter((a) => a !== id) });
    this.set({ albums: this.state.albums.filter((a) => a.id !== id) });
    this.setFilter(f);
  };
  addToAlbum = (albumId: string, ids = this.targets()) => {
    for (const id of ids) { const p = this.state.photos.find((x) => x.id === id); if (p && !p.info.albumIds.includes(albumId)) this.patchInfo(id, { albumIds: [...p.info.albumIds, albumId] }); }
  };
  removeFromAlbum = (albumId: string, ids = this.targets()) => {
    for (const id of ids) { const p = this.state.photos.find((x) => x.id === id); if (p?.info.albumIds.includes(albumId)) this.patchInfo(id, { albumIds: p.info.albumIds.filter((a) => a !== albumId) }); }
  };

  // filter / sort / selection
  setFilter = (f: LibraryFilter) => this.setPhotos(this.state.photos, { filter: f });
  patchFilter = (patch: Partial<LibraryFilter>) => this.setFilter({ ...this.state.filter, ...patch });
  clearFilter = () => this.setFilter(NO_FILTER);
  setSort = (sort: SortKey, desc = sort === 'rating') => this.setPhotos(this.state.photos, { sort, sortDesc: desc });
  toggleSortDirection = () => this.setPhotos(this.state.photos, { sortDesc: !this.state.sortDesc });
  /** Filmstrip click: plain = open; Ctrl/Cmd = toggle in selection; Shift = range from the open photo. */
  clickPhoto = (id: string, mod: { ctrl?: boolean; shift?: boolean } = {}) => {
    const { visible, selection, currentId } = this.state;
    if (mod.shift && currentId) {
      const a = visible.indexOf(currentId), b = visible.indexOf(id);
      if (a >= 0 && b >= 0) { this.set({ selection: visible.slice(Math.min(a, b), Math.max(a, b) + 1) }); return; }
    }
    if (mod.ctrl) {
      const base = selection.length ? selection : currentId ? [currentId] : [];
      this.set({ selection: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] });
      return;
    }
    this.set({ selection: [] });
    void this.select(id);
  };
  selectAllVisible = () => this.set({ selection: [...this.state.visible] });
  clearSelection = () => this.set({ selection: [] });
  /** Open the next/previous photo in the filtered, sorted list. */
  step = (d: 1 | -1) => {
    const { visible, currentId } = this.state;
    const i = currentId ? visible.indexOf(currentId) : -1;
    const next = visible[i < 0 ? 0 : i + d];
    if (next) void this.select(next);
  };


  // ---------------------------------------------------------------- snapshots (named copies of all edits, per photo)
  addSnapshot = (name?: string) => {
    const id = this.state.currentId, p = this.state.photos.find((x) => x.id === id);
    if (!id || !p) return;
    const n = name?.trim() || `Snapshot ${p.info.snapshots.length + 1}`;
    this.patchInfo(id, { snapshots: [...p.info.snapshots, { id: crypto.randomUUID(), name: n, time: Date.now(), params: JSON.parse(JSON.stringify(this.state.params)) }] });
  };
  applySnapshot = (sid: string) => {
    const snap = this.state.photos.find((x) => x.id === this.state.currentId)?.info.snapshots.find((x) => x.id === sid);
    if (snap) this.applyParamsEdit(() => normalizeParams(JSON.parse(JSON.stringify(snap.params))), `Snapshot: ${snap.name}`);
  };
  renameSnapshot = (sid: string, name: string) => {
    const id = this.state.currentId, p = this.state.photos.find((x) => x.id === id);
    if (id && p && name.trim()) this.patchInfo(id, { snapshots: p.info.snapshots.map((s) => (s.id === sid ? { ...s, name: name.trim() } : s)) });
  };
  deleteSnapshot = (sid: string) => {
    const id = this.state.currentId, p = this.state.photos.find((x) => x.id === id);
    if (id && p) this.patchInfo(id, { snapshots: p.info.snapshots.filter((s) => s.id !== sid) });
  };

  // ---------------------------------------------------------------- batch edits on any photo (open or not)
  private async historyFor(id: string): Promise<EditHistory> {
    let h = this.histories.get(id);
    if (!h) {
      const saved = await this.db.getEdits(id);
      h = createHistory(normalizeParams(saved?.edits), saved ? 'Saved edits' : 'Original');
      this.histories.set(id, h);
    }
    return h;
  }
  /** One undoable edit on each photo. The open photo goes through the normal path; others are saved straight away. */
  async editPhotos(ids: string[], fn: (p: EditParams) => EditParams, label: string) {
    for (const id of ids) {
      const h = await this.historyFor(id);
      const next = applyEdit(h, fn, label);
      if (id === this.state.currentId) { this.setHistory(next); continue; }
      this.histories.set(id, next);
      await this.db.putEdits({ photoId: id, version: EDIT_SCHEMA_VERSION, edits: present(next), updatedAt: Date.now() });
      this.markEdited(id, present(next));
    }
  }

  // ---------------------------------------------------------------- presets and copy / paste settings
  allPresets = (): Preset[] => [...BUILTIN_PRESETS, ...this.state.userPresets.map((u) => ({ id: u.id, name: u.name, group: u.group, data: u.data }))];
  applyPresetTo = async (preset: Preset, ids = this.targets()) => {
    await this.editPhotos(ids, (p) => applyPreset(p, preset.data), `Preset: ${preset.name}`);
    if (ids.length > 1) this.toast(`Applied “${preset.name}” to ${ids.length} photos.`);
  };
  saveUserPreset = async (name: string, groups: GroupId[]): Promise<boolean> => {
    const n = name.trim();
    if (!n || !groups.length) return false;
    const rec: PresetRecord = { id: crypto.randomUUID(), name: n, group: 'User Presets', createdAt: Date.now(), data: extractPreset(this.state.params, groups) };
    await this.db.putPreset(rec);
    this.set({ userPresets: [...this.state.userPresets, rec] });
    return true;
  };
  deleteUserPreset = async (id: string) => {
    await this.db.deletePreset(id);
    this.set({ userPresets: this.state.userPresets.filter((p) => p.id !== id) });
  };
  /** Presets as a JSON document (user presets only). */
  exportUserPresets = (): string => JSON.stringify({ roomlightPresets: 1, presets: this.state.userPresets.map(({ name, group, data }) => ({ name, group, data })) }, null, 2);
  importPresets = async (text: string): Promise<number> => {
    let doc: { presets?: { name?: unknown; group?: unknown; data?: unknown }[] };
    try { doc = JSON.parse(text); } catch { this.toast('That file is not valid JSON, so no presets were imported.'); return 0; }
    const list = Array.isArray(doc?.presets) ? doc.presets : [];
    const added: PresetRecord[] = [];
    for (const x of list.slice(0, 200)) {
      const data = sanitizePreset(x?.data);
      if (!data || typeof x.name !== 'string' || !x.name.trim()) continue;
      const rec: PresetRecord = { id: crypto.randomUUID(), name: x.name.trim().slice(0, 80), group: 'User Presets', createdAt: Date.now() + added.length, data };
      await this.db.putPreset(rec);
      added.push(rec);
    }
    if (added.length) this.set({ userPresets: [...this.state.userPresets, ...added] });
    this.toast(added.length ? `Imported ${added.length} preset${added.length > 1 ? 's' : ''}.` : 'No valid presets were found in that file.');
    return added.length;
  };

  copySettings = (groups: GroupId[] = DEFAULT_GROUPS) => {
    const id = this.state.currentId;
    if (!id || !groups.length) return;
    const from = this.state.photos.find((p) => p.id === id)?.name ?? '';
    this.set({ clipboard: { groups, data: extractPreset(this.state.params, groups), from } });
  };
  /** Paste the copied groups (optionally only some of them) onto the targets. */
  pasteSettings = async (only?: GroupId[], ids = this.targets()) => {
    const c = this.state.clipboard;
    if (!c) return this.toast('Nothing copied yet. Use Copy settings first.');
    await this.editPhotos(ids, (p) => applyPreset(p, c.data, only), 'Paste Settings');
    if (ids.length > 1) this.toast(`Pasted settings onto ${ids.length} photos.`);
  };
  resetPhotos = async (ids = this.targets()) => { await this.editPhotos(ids, () => ({ ...DEFAULT_PARAMS, curves: normalizeParams({}).curves }), 'Reset All'); };

  /** Auto tone from the histogram of the unedited photo (see image-engine/autoTone.ts). */
  autoTone = () => {
    const h = this.h(), img = this.state.image;
    if (!h || !img) return;
    this.setHistory(setParams(h, autoTone(img.analysis), 'Auto Tone'));
  };


  // ---------------------------------------------------------------- export
  private exportCancelled = false;
  setExportSettings = (fn: (s: ExportSettings) => ExportSettings) => {
    const next = normalizeExport(fn(this.state.exportSettings));
    this.set({ exportSettings: next });
    void this.db.setMeta('exportSettings', next);
  };
  setExportScope = (exportScope: 'open' | 'selected' | 'shown') => this.set({ exportScope, exportSummary: null });
  cancelExport = () => { this.exportCancelled = true; };
  clearExportSummary = () => this.set({ exportSummary: null });

  /** Export photos at full resolution with the current export settings. Photos are rendered one at a time, off the main thread when possible. */
  exportPhotos = async (ids: string[]) => {
    const settings = this.state.exportSettings;
    if (!ids.length || this.state.exportStatus) return;
    this.exportCancelled = false;
    this.set({ exportSummary: null, exportStatus: { done: 0, total: ids.length, stage: 'Starting', name: '' } });
    const out: { base: string; ext: string; bytes: Uint8Array; mime: string; date: Date }[] = [];
    const notes = new Set<string>(), where = new Set<'worker' | 'main'>();
    let size = '';
    try {
      for (let i = 0; i < ids.length; i++) {
        if (this.exportCancelled) break;
        const rec = this.records.get(ids[i]), sum = this.state.photos.find((p) => p.id === ids[i]);
        if (!rec || !sum) continue;
        const params = present(await this.historyFor(ids[i]));
        this.set({ exportStatus: { done: i, total: ids.length, stage: 'Starting', name: rec.name } });
        const native = resolveSize(outputSize(params, rec.width, rec.height), settings.resize);
        const res = await runExport({ original: rec.original, name: rec.name, type: rec.type, params, settings, fullWidth: rec.width }, (stage) => this.set({ exportStatus: { done: i, total: ids.length, stage, name: rec.name } }));
        where.add(res.ranIn);
        res.notes.forEach((n) => notes.add(n));
        size = `${res.width} × ${res.height}`;
        const date = new Date(sum.info.exif?.capturedAt ?? sum.addedAt);
        out.push({ base: formatFilename(settings.filename, { name: rec.name, index: i + 1, total: ids.length, date, rating: sum.info.rating, title: sum.info.title, width: native.w, height: native.h }), ext: res.ext, bytes: res.bytes, mime: res.mime, date });
      }
      const names = uniqueNames(out.map((o) => o.base)).map((n, i) => `${n}.${out[i].ext}`);
      if (out.length > 1 && settings.zip) {
        const zip = zipStore(out.map((o, i) => ({ name: names[i], data: o.bytes, date: o.date })));
        saveBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `roomlight-export-${new Date().toISOString().slice(0, 10)}.zip`);
      } else {
        for (let i = 0; i < out.length; i++) { saveBlob(new Blob([out[i].bytes as BlobPart], { type: out[i].mime }), names[i]); if (out.length > 1) await new Promise((r) => setTimeout(r, 250)); }
      }
      this.set({ exportSummary: { files: out.length, bytes: out.reduce((s, o) => s + o.bytes.length, 0), notes: [...notes], ranIn: where.size > 1 ? 'mixed' : (where.values().next().value ?? 'main'), zip: out.length > 1 && settings.zip, cancelled: this.exportCancelled, names, size } });
    } catch (e) {
      this.toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.set({ exportStatus: null });
    }
  };

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

  isEdited = () => !isDefault(this.state.params);
}

export const store = new EditorStore(new IndexedDbPhotoStore());

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
