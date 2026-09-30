import { useRef } from 'react';
import { PRESET_GROUPS } from '../presets/builtin';
import { groupsIn } from '../presets/snapshot';
import { GROUP_BY_ID } from '../presets/groups';
import { Panel } from '../ui/Panel';
import { store, useEditor } from './store';

/** Right column (Edit tool): built-in and user presets, save / import / export. */
export function PresetsPanel() {
  const userPresets = useEditor((s) => s.userPresets);
  const fileRef = useRef<HTMLInputElement>(null);
  const all = store.allPresets();
  const groups = [...PRESET_GROUPS, ...(userPresets.length ? ['User Presets'] : [])];
  const download = () => {
    const url = URL.createObjectURL(new Blob([store.exportUserPresets()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'roomlight-presets.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const targets = store.targets();
  return (
    <Panel title="Presets" defaultOpen={false}>
      <p className="note" style={{ marginTop: 0 }}>{targets.length > 1 ? `Applies to the ${targets.length} selected photos.` : 'Applies to the open photo.'} Each preset changes only the settings it contains, as one undoable step.</p>
      {groups.map((g) => (
        <div key={g} className="preset-group">
          <div className="subhead">{g}</div>
          <div className="preset-list">
            {all.filter((p) => p.group === g).map((p) => (
              <div key={p.id} className="preset-row" data-preset={p.name}>
                <button className="preset" title={`Contains: ${groupsIn(p.data).map((id) => GROUP_BY_ID[id].label).join(', ')}`} onClick={() => void store.applyPresetTo(p)}>{p.name}</button>
                {g === 'User Presets' && <button className="icon" aria-label={`Delete preset ${p.name}`} title="Delete preset" onClick={() => { if (confirm(`Delete preset “${p.name}”?`)) void store.deleteUserPreset(p.id); }}>×</button>}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="row-buttons">
        <button className="tool" onClick={() => store.openDialog('savePreset')} title="Save the current settings as a preset">Save current as preset…</button>
      </div>
      <div className="row-buttons">
        <button className="tool" disabled={!userPresets.length} onClick={download} title="Download your presets as a JSON file">Export presets</button>
        <button className="tool" onClick={() => fileRef.current?.click()} title="Load presets from a JSON file">Import presets…</button>
        <input ref={fileRef} type="file" hidden accept="application/json,.json" data-testid="preset-file" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await store.importPresets(await f.text()); }} />
      </div>
    </Panel>
  );
}
