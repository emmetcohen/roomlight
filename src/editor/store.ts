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
import { cropIsValid, flip as flipCrop, resetCropTool, rotate90 as rotateCrop, setAspect, swapAspectOrientation } from '../geometry/cropActions';
import type { AspectPreset, Crop } from '../geometry/crop';
import { geoOf, makeGeoMap, outputToSource } from '../geometry/transform';
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
  /** RGBA8 of the decoded original (input to retouching). Never modified. */
  pixels: Pixels;
}

export type Tool = 'edit' | 'crop' | 'mask' | 'retouch';

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
  tool: Tool;
  selectedMask: string | null;
  selectedComp: string | null;
  selectedSpot: string | null;
  retouch: RetouchSettings;
  brush: BrushSettings;
  showOverlay: boolean;
  pickingColor: boolean;
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
  tool: 'edit',
  selectedMask: null,
  selectedComp: null,
  selectedSpot: null,
  retouch: { kind: 'heal', size: 30, feather: 40, opacity: 100 },
  brush: { size: 40, feather: 50, flow: 100, density: 100, erase: false },
  showOverlay: true,
  pickingColor: false,
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
      const pixels = readPixels(dec.bitmap);
      this.state.image?.bitmap.close();
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
    return b ? { aspect: b.width / b.height } : undefined;
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

  // ---------------------------------------------------------------- tools
  setTool = (tool: Tool) => this.set({ tool, eyedropper: false, pickingColor: false });

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
