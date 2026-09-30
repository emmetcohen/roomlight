/** Export settings, size resolution and file naming (pure; unit-tested). */
export type ExportFormat = 'jpeg' | 'png' | 'webp';
export type ResizeMode = 'original' | 'longEdge' | 'fit' | 'percent';
export type SharpenLevel = 'off' | 'low' | 'standard' | 'high';
export type MetadataMode = 'none' | 'original' | 'basic';

export interface ExportSettings {
  format: ExportFormat;
  /** 1..100 (JPEG, WebP). */
  quality: number;
  resize: { mode: ResizeMode; longEdge: number; width: number; height: number; percent: number; noEnlarge: boolean };
  sharpen: SharpenLevel;
  /** Transparent corners (from rotation) are filled with this for JPEG, which has no transparency. */
  background: string;
  metadata: { mode: MetadataMode; removeLocation: boolean; copyright: string; artist: string };
  /** File name template without extension: {name} {n} {nn} {nnn} {date} {rating} {title} {w} {h} */
  filename: string;
  /** Several photos: one ZIP (recommended) or separate downloads. */
  zip: boolean;
}

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'jpeg', quality: 92,
  resize: { mode: 'original', longEdge: 2048, width: 1920, height: 1080, percent: 50, noEnlarge: true },
  sharpen: 'off', background: '#ffffff',
  metadata: { mode: 'original', removeLocation: true, copyright: '', artist: '' },
  filename: '{name}-edit', zip: true,
};

export const FORMAT_INFO: Record<ExportFormat, { label: string; mime: string; ext: string; lossy: boolean }> = {
  jpeg: { label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  png: { label: 'PNG (lossless)', mime: 'image/png', ext: 'png', lossy: false },
  webp: { label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true },
};

export const SHARPEN_AMOUNT: Record<SharpenLevel, number> = { off: 0, low: 30, standard: 60, high: 100 };
/** Output sharpening radius (σ, px): grows with the output size, between 0.6 and 1.8 px. */
export const sharpenSigma = (longEdge: number) => Math.min(1.8, Math.max(0.6, longEdge / 3000));

export const MAX_EXPORT_PIXELS = 120e6;

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/** Validate settings from storage (older versions, hand-edited, ...). */
export function normalizeExport(raw: unknown): ExportSettings {
  const d = DEFAULT_EXPORT;
  if (!raw || typeof raw !== 'object') return structuredClone(d);
  const r = raw as Partial<ExportSettings> & Record<string, Record<string, unknown>>;
  const fmt: ExportFormat = r.format === 'png' || r.format === 'webp' ? r.format : 'jpeg';
  const rs = (r.resize ?? {}) as Partial<ExportSettings['resize']>, md = (r.metadata ?? {}) as Partial<ExportSettings['metadata']>;
  const mode: ResizeMode = rs.mode === 'longEdge' || rs.mode === 'fit' || rs.mode === 'percent' ? rs.mode : 'original';
  return {
    format: fmt,
    quality: clampInt(Number(r.quality ?? d.quality), 1, 100),
    resize: { mode, longEdge: clampInt(Number(rs.longEdge ?? d.resize.longEdge), 16, 30000), width: clampInt(Number(rs.width ?? d.resize.width), 16, 30000), height: clampInt(Number(rs.height ?? d.resize.height), 16, 30000), percent: clampInt(Number(rs.percent ?? d.resize.percent), 1, 400), noEnlarge: rs.noEnlarge !== false },
    sharpen: r.sharpen === 'low' || r.sharpen === 'standard' || r.sharpen === 'high' ? r.sharpen : 'off',
    background: typeof r.background === 'string' && /^#[0-9a-f]{6}$/i.test(r.background) ? r.background : d.background,
    metadata: { mode: md.mode === 'none' || md.mode === 'basic' ? md.mode : 'original', removeLocation: md.removeLocation !== false, copyright: typeof md.copyright === 'string' ? md.copyright.slice(0, 200) : '', artist: typeof md.artist === 'string' ? md.artist.slice(0, 200) : '' },
    filename: typeof r.filename === 'string' && r.filename.trim() ? r.filename.slice(0, 120) : d.filename,
    zip: r.zip !== false,
  };
}

/** Final pixel size for a native (full-resolution, cropped) size. */
export function resolveSize(native: { w: number; h: number }, r: ExportSettings['resize']): { w: number; h: number } {
  let k = 1;
  if (r.mode === 'longEdge') k = r.longEdge / Math.max(native.w, native.h);
  else if (r.mode === 'fit') k = Math.min(r.width / native.w, r.height / native.h);
  else if (r.mode === 'percent') k = r.percent / 100;
  if (r.noEnlarge && r.mode !== 'percent' && k > 1) k = 1;
  return { w: Math.max(1, Math.round(native.w * k)), h: Math.max(1, Math.round(native.h * k)) };
}

// ---------------------------------------------------------------- file names
export interface NameContext { name: string; index: number; total: number; date: Date; rating: number; title: string; width: number; height: number }

export function sanitizeFilename(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 120).trim();
  return t || 'photo';
}

export function formatFilename(template: string, c: NameContext): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const d = c.date;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  const base = c.name.replace(/\.[^.]+$/, '');
  const out = template.replace(/\{(name|n|nn|nnn|date|rating|title|w|h)\}/g, (_, k: string) => {
    switch (k) {
      case 'name': return base; case 'n': return String(c.index); case 'nn': return pad(c.index, 2); case 'nnn': return pad(c.index, 3);
      case 'date': return date; case 'rating': return String(c.rating); case 'title': return c.title || base; case 'w': return String(c.width); default: return String(c.height);
    }
  });
  return sanitizeFilename(out);
}

/** Make names unique within a batch, case-insensitively: a, a-2, a-3 ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const c = (seen.get(key) ?? 0) + 1;
    seen.set(key, c);
    return c === 1 ? n : `${n}-${c}`;
  });
}
