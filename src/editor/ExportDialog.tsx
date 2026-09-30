import { outputSize } from '../geometry/transform';
import { FORMAT_INFO, formatFilename, resolveSize, type ExportFormat, type MetadataMode, type ResizeMode, type SharpenLevel } from '../export/types';
import { Dialog } from '../ui/Dialog';
import { NumberField } from '../ui/NumberField';
import { SliderView } from '../ui/Slider';
import { store, useEditor } from './store';

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
type Scope = 'open' | 'selected' | 'shown';

export function ExportDialog() {
  const s = useEditor((x) => x.exportSettings);
  const status = useEditor((x) => x.exportStatus);
  const summary = useEditor((x) => x.exportSummary);
  const photos = useEditor((x) => x.photos);
  const visible = useEditor((x) => x.visible);
  const selection = useEditor((x) => x.selection);
  const currentId = useEditor((x) => x.currentId);
  const params = useEditor((x) => x.params);
  const scopeState = useEditor((x) => x.exportScope);
  const scope: Scope = scopeState === 'selected' && selection.length < 2 ? 'open' : scopeState;
  const ids = scope === 'shown' ? visible : scope === 'selected' ? selection : currentId ? [currentId] : [];
  const cur = photos.find((p) => p.id === currentId);
  const set = store.setExportSettings;
  const busy = !!status;

  const native = cur ? outputSize(params, cur.width, cur.height) : { w: 0, h: 0 };
  const out = resolveSize(native, s.resize);
  const first = photos.find((p) => p.id === ids[0]);
  const preview = first ? `${formatFilename(s.filename, { name: first.name, index: 1, total: ids.length, date: new Date(first.info.exif?.capturedAt ?? first.addedAt), rating: first.info.rating, title: first.info.title, width: out.w, height: out.h })}.${FORMAT_INFO[s.format].ext}` : '';
  const jpeg = s.format === 'jpeg';
  const hasGps = !!cur?.info.exif?.gps;
  const lossy = FORMAT_INFO[s.format].lossy;

  return (
    <Dialog title="Export" wide onClose={() => { if (!busy) { store.clearExportSummary(); store.closeDialog(); } }}>
      <fieldset disabled={busy} className="export-form">
        <div className="exp-row"><span className="exp-label">Photos</span>
          <div className="seg" role="group" aria-label="Which photos">
            <button className={scope === 'open' ? 'on' : ''} onClick={() => store.setExportScope('open')}>Open photo</button>
            <button className={scope === 'selected' ? 'on' : ''} disabled={selection.length < 2} onClick={() => store.setExportScope('selected')}>Selected ({selection.length})</button>
            <button className={scope === 'shown' ? 'on' : ''} disabled={!visible.length} onClick={() => store.setExportScope('shown')}>All shown ({visible.length})</button>
          </div>
        </div>
        <div className="exp-row"><span className="exp-label">Format</span>
          <select aria-label="Format" value={s.format} onChange={(e) => set((x) => ({ ...x, format: e.target.value as ExportFormat }))}>
            {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => <option key={f} value={f}>{FORMAT_INFO[f].label}</option>)}
          </select>
        </div>
        {lossy && (
          <SliderView label="Quality" ariaLabel="Export quality" value={s.quality} min={1} max={100} step={1} defaultValue={92} signed={false}
            onPreview={(v) => set((x) => ({ ...x, quality: v }))} onCommit={() => undefined} onSet={(v) => set((x) => ({ ...x, quality: v }))} onReset={() => set((x) => ({ ...x, quality: 92 }))} />
        )}
        {jpeg && <div className="exp-row"><span className="exp-label">Fill</span><input type="color" aria-label="Background for transparent areas" value={s.background} onChange={(e) => set((x) => ({ ...x, background: e.target.value }))} /><span className="muted small">JPEG has no transparency; empty corners get this colour.</span></div>}

        <div className="exp-row"><span className="exp-label">Size</span>
          <select aria-label="Resize" value={s.resize.mode} onChange={(e) => set((x) => ({ ...x, resize: { ...x.resize, mode: e.target.value as ResizeMode } }))}>
            <option value="original">Full size (as edited)</option><option value="longEdge">Long edge</option><option value="fit">Fit in a box</option><option value="percent">Percent</option>
          </select>
          {s.resize.mode === 'longEdge' && <><NumberField label="Long edge in pixels" min={16} max={30000} value={s.resize.longEdge} onCommit={(v) => set((x) => ({ ...x, resize: { ...x.resize, longEdge: v } }))} /><span className="muted">px</span></>}
          {s.resize.mode === 'fit' && <><NumberField label="Box width" min={16} max={30000} value={s.resize.width} onCommit={(v) => set((x) => ({ ...x, resize: { ...x.resize, width: v } }))} /><span className="muted">×</span><NumberField label="Box height" min={16} max={30000} value={s.resize.height} onCommit={(v) => set((x) => ({ ...x, resize: { ...x.resize, height: v } }))} /></>}
          {s.resize.mode === 'percent' && <><NumberField label="Percent" min={1} max={400} value={s.resize.percent} onCommit={(v) => set((x) => ({ ...x, resize: { ...x.resize, percent: v } }))} /><span className="muted">%</span></>}
        </div>
        {(s.resize.mode === 'longEdge' || s.resize.mode === 'fit') && <label className="chk exp-indent"><input type="checkbox" checked={s.resize.noEnlarge} onChange={(e) => set((x) => ({ ...x, resize: { ...x.resize, noEnlarge: e.target.checked } }))} />Don’t enlarge</label>}
        {cur && <div className="readout" data-testid="export-size">{out.w} × {out.h} px · {((out.w * out.h) / 1e6).toFixed(1)} MP{native.w !== out.w ? ` (full size ${native.w} × ${native.h})` : ''}</div>}

        <div className="exp-row"><span className="exp-label">Sharpening</span>
          <select aria-label="Output sharpening" value={s.sharpen} onChange={(e) => set((x) => ({ ...x, sharpen: e.target.value as SharpenLevel }))}>
            <option value="off">Off</option><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option>
          </select>
          <span className="muted small">Applied to the final pixels, after resizing.</span>
        </div>

        <div className="exp-row"><span className="exp-label">Metadata</span>
          <select aria-label="Metadata" disabled={!jpeg} value={jpeg ? s.metadata.mode : 'none'} onChange={(e) => set((x) => ({ ...x, metadata: { ...x.metadata, mode: e.target.value as MetadataMode } }))}>
            <option value="original">Keep original EXIF</option><option value="basic">Camera &amp; exposure only</option><option value="none">None</option>
          </select>
        </div>
        {!jpeg && <p className="note exp-indent">Metadata can only be embedded in JPEG files.</p>}
        {jpeg && <label className="chk exp-indent"><input type="checkbox" checked={s.metadata.removeLocation} onChange={(e) => set((x) => ({ ...x, metadata: { ...x.metadata, removeLocation: e.target.checked } }))} />Remove location (GPS){hasGps && <b className="gps-flag"> — this photo has location data</b>}</label>}
        {jpeg && (
          <div className="exp-row exp-indent">
            <input className="text" aria-label="Copyright notice" placeholder="Copyright notice" value={s.metadata.copyright} onChange={(e) => set((x) => ({ ...x, metadata: { ...x.metadata, copyright: e.target.value } }))} onKeyDown={(e) => e.stopPropagation()} />
            <input className="text" aria-label="Creator" placeholder="Creator" value={s.metadata.artist} onChange={(e) => set((x) => ({ ...x, metadata: { ...x.metadata, artist: e.target.value } }))} onKeyDown={(e) => e.stopPropagation()} />
          </div>
        )}
        {jpeg && (s.metadata.copyright || s.metadata.artist) && <p className="note exp-indent">A copyright or creator notice writes a fresh EXIF block from the fields Roomlight understands (camera, lens, exposure, date{s.metadata.removeLocation ? '' : ', location'}).</p>}

        <div className="exp-row"><span className="exp-label">File name</span>
          <input className="text" aria-label="File name template" value={s.filename} onChange={(e) => set((x) => ({ ...x, filename: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <p className="note exp-indent" data-testid="export-filename">Tokens: {'{name} {n} {nnn} {date} {rating} {title} {w} {h}'} · first file: <b>{preview}</b></p>
        {ids.length > 1 && <label className="chk exp-indent"><input type="checkbox" checked={s.zip} onChange={(e) => set((x) => ({ ...x, zip: e.target.checked }))} />Bundle into one ZIP file (browsers may block many separate downloads)</label>}
        <p className="note">Exports are sRGB. Edits are applied to the original file at full resolution, not to the on-screen preview.</p>
      </fieldset>

      {status && (
        <div className="exp-progress" role="status" data-testid="export-progress">
          <progress max={status.total} value={status.done} />
          <span>{status.stage}… {status.name} ({status.done + 1} of {status.total})</span>
          <button onClick={store.cancelExport}>Cancel</button>
        </div>
      )}
      {summary && !busy && (
        <div className="exp-done" data-testid="export-done">
          <b>{summary.cancelled ? 'Cancelled after ' : 'Exported '}{summary.files} file{summary.files === 1 ? '' : 's'}</b> · {fmtBytes(summary.bytes)}{summary.size && summary.files === 1 ? ` · ${summary.size} px` : ''}{summary.zip ? ' · one ZIP' : ''}
          <div className="muted small" data-testid="export-where">{summary.ranIn === 'worker' ? 'Rendered in a background worker.' : summary.ranIn === 'main' ? 'Rendered on the main thread (background workers are not available here).' : 'Rendered partly in a worker, partly on the main thread.'}</div>
          {summary.notes.map((n, i) => <div key={i} className="note warn">{n}</div>)}
        </div>
      )}
      <footer className="dialog-foot">
        <button onClick={() => { store.clearExportSummary(); store.closeDialog(); }} disabled={busy}>Close</button>
        <button className="primary-sm" data-testid="export-go" disabled={busy || !ids.length} onClick={() => void store.exportPhotos(ids)}>{ids.length > 1 ? `Export ${ids.length} photos` : 'Export'}</button>
      </footer>
    </Dialog>
  );
}
