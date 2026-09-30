import { useState } from 'react';
import type { Snapshot } from '../library/types';
import { store, useEditor } from './store';

const NONE: Snapshot[] = []; // a stable empty list (a selector must not return a new array each call)

/** Named copies of ALL of a photo's edits. Click to restore (one undoable step). */
export function SnapshotsPanel() {
  const snaps = useEditor((s) => s.photos.find((p) => p.id === s.currentId)?.info.snapshots ?? NONE);
  const has = useEditor((s) => !!s.currentId);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  return (
    <div className="snapshots">
      <form className="lib-row" onSubmit={(e) => { e.preventDefault(); store.addSnapshot(name); setName(''); }}>
        <input className="text" placeholder="Snapshot name (optional)" aria-label="Snapshot name" value={name} disabled={!has} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="tool" data-testid="add-snapshot" disabled={!has} title="Save the current edits as a snapshot">＋</button>
      </form>
      {snaps.length === 0 && <p className="note">No snapshots. A snapshot stores every setting as it is now, so you can come back to it.</p>}
      <ul className="album-list">
        {snaps.map((s) => (
          <li key={s.id} data-snapshot={s.name}>
            {editing === s.id ? (
              <input className="text" autoFocus aria-label="Snapshot name" value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === 'Enter') { store.renameSnapshot(s.id, editName); setEditing(null); } if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} />
            ) : (
              <button className="album-name" title={`Apply “${s.name}” — double-click to rename\n${new Date(s.time).toLocaleString()}`} onClick={() => store.applySnapshot(s.id)} onDoubleClick={() => { setEditing(s.id); setEditName(s.name); }}>{s.name}</button>
            )}
            <button className="icon" aria-label={`Delete snapshot ${s.name}`} title="Delete snapshot" onClick={() => store.deleteSnapshot(s.id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
