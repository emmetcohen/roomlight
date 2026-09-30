import { useState } from 'react';
import { ALL_GROUPS, COPY_GROUPS, DEFAULT_GROUPS, type GroupId } from '../presets/groups';
import { groupsIn } from '../presets/snapshot';
import { Dialog } from '../ui/Dialog';
import { store, useEditor } from './store';

function GroupPicker({ available, value, onChange }: { available: GroupId[]; value: GroupId[]; onChange: (g: GroupId[]) => void }) {
  const toggle = (id: GroupId) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <>
      <div className="row-buttons">
        <button className="tool" onClick={() => onChange(available.filter((id) => DEFAULT_GROUPS.includes(id)))}>Defaults</button>
        <button className="tool" onClick={() => onChange([...available])}>All</button>
        <button className="tool" onClick={() => onChange([])}>None</button>
      </div>
      <ul className="group-list">
        {COPY_GROUPS.filter((g) => available.includes(g.id)).map((g) => (
          <li key={g.id}>
            <label className="chk"><input type="checkbox" data-group={g.id} checked={value.includes(g.id)} onChange={() => toggle(g.id)} />{g.label}</label>
            {g.note && <span className="muted small">{g.note}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** "Copy settings…": choose groups, then keep them on the clipboard. */
export function CopyDialog() {
  const [groups, setGroups] = useState<GroupId[]>(store.getState().clipboard?.groups ?? DEFAULT_GROUPS);
  return (
    <Dialog title="Copy settings" onClose={store.closeDialog}>
      <p className="note" style={{ marginTop: 0 }}>Choose which settings to copy from this photo.</p>
      <GroupPicker available={ALL_GROUPS} value={groups} onChange={setGroups} />
      <footer className="dialog-foot">
        <button onClick={store.closeDialog}>Cancel</button>
        <button className="primary-sm" disabled={!groups.length} data-testid="copy-confirm" onClick={() => { store.copySettings(groups); store.closeDialog(); }}>Copy</button>
      </footer>
    </Dialog>
  );
}

/** "Paste settings…": choose which of the copied groups to paste. */
export function PasteDialog() {
  const clip = useEditor((s) => s.clipboard);
  const selection = useEditor((s) => s.selection);
  const avail = clip ? groupsIn(clip.data) : [];
  const [groups, setGroups] = useState<GroupId[]>(avail);
  const targets = store.targets();
  if (!clip) return <Dialog title="Paste settings" onClose={store.closeDialog}><p className="note">Nothing copied yet.</p></Dialog>;
  return (
    <Dialog title="Paste settings" onClose={store.closeDialog}>
      <p className="note" style={{ marginTop: 0 }}>Copied from <b>{clip.from || 'a photo'}</b>. Pasting onto {selection.length > 1 ? `${selection.length} selected photos` : 'the open photo'} replaces only the ticked settings; everything else stays as it is.</p>
      <GroupPicker available={avail} value={groups} onChange={setGroups} />
      <footer className="dialog-foot">
        <button onClick={store.closeDialog}>Cancel</button>
        <button className="primary-sm" disabled={!groups.length || !targets.length} data-testid="paste-confirm" onClick={() => { void store.pasteSettings(groups); store.closeDialog(); }}>Paste</button>
      </footer>
    </Dialog>
  );
}

/** "Save current as preset…" */
export function SavePresetDialog() {
  const [name, setName] = useState('');
  const [groups, setGroups] = useState<GroupId[]>(DEFAULT_GROUPS);
  const submit = async () => { if (await store.saveUserPreset(name, groups)) store.closeDialog(); };
  return (
    <Dialog title="Save preset" onClose={store.closeDialog}>
      <label className="field"><span className="muted small">Name</span><input className="text" autoFocus aria-label="Preset name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); e.stopPropagation(); }} /></label>
      <p className="note">Choose what the preset contains. Applying it later changes only these settings.</p>
      <GroupPicker available={ALL_GROUPS} value={groups} onChange={setGroups} />
      <footer className="dialog-foot">
        <button onClick={store.closeDialog}>Cancel</button>
        <button className="primary-sm" disabled={!name.trim() || !groups.length} data-testid="preset-save" onClick={() => void submit()}>Save preset</button>
      </footer>
    </Dialog>
  );
}
