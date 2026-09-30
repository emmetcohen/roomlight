import { useEffect, useMemo, useRef, useState } from 'react';
import { makePreviewSource, renderPresetPreview, type PreviewSource } from '../presets/preview';
import { PRESET_GROUPS, type Preset } from '../presets/builtin';
import { groupsIn } from '../presets/snapshot';
import { GROUP_BY_ID } from '../presets/groups';
import { Menu, MenuItem } from '../ui/Menu';
import { store, useEditor } from './store';

/** One preset: a thumbnail of the open photo with the preset applied, its name, a star, and (your own presets) a delete button. */
function PresetCard({ preset, src, index, mine }: { preset: Preset; src: PreviewSource | null; index: number; mine: boolean }) {
  const params = useEditor((s) => s.params);
  const fav = useEditor((s) => s.favoritePresets.includes(preset.id));
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !src) return;
    // stagger the tiny renders so opening the panel never blocks the UI
    const t = setTimeout(() => {
      const r = renderPresetPreview(src, params, preset.data);
      c.width = r.width; c.height = r.height;
      c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
    }, 12 + index * 6);
    return () => clearTimeout(t);
  }, [src, params, preset, index]);
  return (
    <div className="preset-card-wrap" data-preset={preset.name} data-favorite={fav ? '1' : '0'}>
      <button className="preset-card" title={`${preset.name} — contains: ${groupsIn(preset.data).map((id) => GROUP_BY_ID[id].label).join(', ')}`} onClick={() => void store.applyPresetTo(preset)}>
        <canvas ref={ref} />
        <span className="preset-label">{preset.name}</span>
      </button>
      <span role="button" tabIndex={0} className={`preset-fav${fav ? ' on' : ''}`} aria-label={fav ? `Remove ${preset.name} from favorites` : `Add ${preset.name} to favorites`} aria-pressed={fav} title={fav ? 'Remove from favorites' : 'Add to favorites (shown under Yours)'}
        onClick={() => store.toggleFavoritePreset(preset.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); store.toggleFavoritePreset(preset.id); } }}>{fav ? '★' : '☆'}</span>
      {mine && <span role="button" tabIndex={0} className="preset-del" aria-label={`Delete preset ${preset.name}`} title="Delete preset" onClick={() => { if (confirm(`Delete preset “${preset.name}”?`)) void store.deleteUserPreset(preset.id); }}>×</span>}
    </div>
  );
}

function Group({ title, presets, src, mine, startIndex = 0 }: { title: string; presets: Preset[]; src: PreviewSource | null; mine: boolean; startIndex?: number }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="preset-group-block" data-preset-group={title}>
      <button className="group-head" aria-expanded={open} onClick={() => setOpen(!open)}><span className={`chev${open ? ' open' : ''}`}>▸</span>{title}<span className="muted"> {presets.length}</span></button>
      {open && <div className="preset-grid">{presets.map((p, i) => <PresetCard key={p.id} preset={p} src={src} index={startIndex + i} mine={mine && !p.builtin} />)}</div>}
    </section>
  );
}

/** The Presets tool (first icon in the tool strip): built-in presets by group, and a "Yours" tab with favorites and your own. */
export function PresetsView() {
  const image = useEditor((s) => s.image);
  const userPresets = useEditor((s) => s.userPresets);
  const favorites = useEditor((s) => s.favoritePresets);
  const selection = useEditor((s) => s.selection);
  const [tab, setTab] = useState<'presets' | 'yours'>('presets');
  const fileRef = useRef<HTMLInputElement>(null);
  const src = useMemo(() => (image ? makePreviewSource(image.analysis) : null), [image]);
  const all = store.allPresets();
  const mine = all.filter((p) => !p.builtin);
  const favs = all.filter((p) => favorites.includes(p.id));
  const download = () => {
    const url = URL.createObjectURL(new Blob([store.exportUserPresets()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'roomlight-presets.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  void userPresets;
  return (
    <div className="presets-view">
      <div className="presets-head">
        <h3>Presets</h3>
        <button className="icon" aria-label="Save current settings as a preset" data-testid="save-preset-btn" title="Save the current settings as a preset" onClick={() => store.openDialog('savePreset')}>＋</button>
        <Menu label="⋯" className="icon" ariaLabel="Preset options" align="right">
          <MenuItem disabled={!mine.length} onClick={download}>Export my presets</MenuItem>
          <MenuItem onClick={() => fileRef.current?.click()}>Import presets…</MenuItem>
        </Menu>
        <input ref={fileRef} type="file" hidden accept="application/json,.json" data-testid="preset-file" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await store.importPresets(await f.text()); }} />
      </div>
      <div className="preset-tabs" role="tablist" aria-label="Preset lists">
        <button role="tab" aria-selected={tab === 'presets'} data-preset-tab="presets" className={tab === 'presets' ? 'on' : ''} onClick={() => setTab('presets')}>Presets</button>
        <button role="tab" aria-selected={tab === 'yours'} data-preset-tab="yours" className={tab === 'yours' ? 'on' : ''} onClick={() => setTab('yours')}>Yours</button>
      </div>
      <p className="note" style={{ margin: '6px 12px' }}>{selection.length > 1 ? `Applies to the ${selection.length} selected photos.` : 'Applies to the open photo.'} Previews show your photo with each preset applied. One undoable step.</p>
      {tab === 'presets' && PRESET_GROUPS.map((g) => <Group key={g} title={g} presets={all.filter((p) => p.builtin && p.group === g)} src={src} mine={false} startIndex={PRESET_GROUPS.indexOf(g) * 5} />)}
      {tab === 'yours' && (
        <>
          <Group title="Favorites" presets={favs} src={src} mine />
          {favs.length === 0 && <p className="note pad" data-testid="no-favorites">No favorites yet. Tap the ☆ on any preset to keep it here.</p>}
          <Group title="My presets" presets={mine} src={src} mine startIndex={favs.length} />
          {mine.length === 0 && <p className="note pad" data-testid="no-mine">You have not saved any presets. Use ＋ above to save the current settings.</p>}
        </>
      )}
    </div>
  );
}
