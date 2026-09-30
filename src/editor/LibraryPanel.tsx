import { useState } from 'react';
import { COLOR_LABELS, LABEL_CSS, filterIsActive, type Flag, type SortKey } from '../library/types';
import { store, useEditor } from './store';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'added', label: 'Date added' }, { key: 'capture', label: 'Capture time' }, { key: 'name', label: 'File name' }, { key: 'rating', label: 'Rating' },
];
const FLAGS: { flag: Flag; label: string; icon: string }[] = [{ flag: 'pick', label: 'Picked', icon: '⚑' }, { flag: 'none', label: 'Unflagged', icon: '○' }, { flag: 'reject', label: 'Rejected', icon: '✕' }];

function Stars({ value, onPick, label }: { value: number; onPick: (n: number) => void; label: string }) {
  return (
    <span className="stars" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={`star${n <= value ? ' on' : ''}`} aria-label={`${n} star${n > 1 ? 's' : ''}`} aria-pressed={n <= value} onClick={() => onPick(n)}>★</button>
      ))}
    </span>
  );
}

/** Left sidebar, "Library" tab: search, filters, sort, albums. */
export function LibraryPanel() {
  const filter = useEditor((s) => s.filter);
  const sort = useEditor((s) => s.sort);
  const sortDesc = useEditor((s) => s.sortDesc);
  const albums = useEditor((s) => s.albums);
  const photos = useEditor((s) => s.photos);
  const selection = useEditor((s) => s.selection);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const count = (id: string) => photos.filter((p) => p.info.albumIds.includes(id)).length;
  const toggleFlag = (f: Flag) => {
    const cur = filter.flags ?? [];
    const next = cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f];
    store.patchFilter({ flags: next.length ? next : null });
  };
  const targets = store.targets();
  return (
    <div className="library">
      <div className="lib-block">
        <input className="text search" type="search" placeholder="Search name, keyword, camera…" aria-label="Search photos" value={filter.text} onChange={(e) => store.patchFilter({ text: e.target.value })} />
      </div>
      <h3>Filter</h3>
      <div className="lib-block">
        <div className="lib-row"><span className="muted">Rating ≥</span>
          <span className="stars" role="group" aria-label="Minimum rating">
            {[1, 2, 3, 4, 5].map((n) => <button key={n} className={`star${n <= filter.minRating ? ' on' : ''}`} aria-label={`At least ${n} star${n > 1 ? 's' : ''}`} aria-pressed={filter.minRating === n} data-min-rating={n} onClick={() => store.patchFilter({ minRating: filter.minRating === n ? 0 : n })}>★</button>)}
          </span>
        </div>
        <div className="lib-row flags" role="group" aria-label="Flag filter">
          {FLAGS.map((f) => <button key={f.flag} data-flag-filter={f.flag} className={filter.flags?.includes(f.flag) ? 'on' : ''} title={f.label} aria-pressed={!!filter.flags?.includes(f.flag)} onClick={() => toggleFlag(f.flag)}>{f.icon}</button>)}
          <span className="sep" />
          {COLOR_LABELS.map((c) => <button key={c} data-label-filter={c} className={`swatch-btn${filter.label === c ? ' on' : ''}`} style={{ background: LABEL_CSS[c] }} title={`Label: ${c}`} aria-label={`Filter label ${c}`} aria-pressed={filter.label === c} onClick={() => store.patchFilter({ label: filter.label === c ? null : c })} />)}
        </div>
        <div className="lib-row"><label className="chk"><input type="checkbox" checked={filter.edited === true} onChange={(e) => store.patchFilter({ edited: e.target.checked ? true : null })} />Edited only</label></div>
        <button className="tool" disabled={!filterIsActive(filter)} onClick={store.clearFilter}>Clear filter</button>
      </div>
      <h3>Sort</h3>
      <div className="lib-block lib-row">
        <select aria-label="Sort by" value={sort} onChange={(e) => store.setSort(e.target.value as SortKey)}>{SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <button className="tool" aria-label="Toggle sort direction" title={sortDesc ? 'Descending' : 'Ascending'} onClick={store.toggleSortDirection}>{sortDesc ? '↓' : '↑'}</button>
      </div>
      <h3>Albums</h3>
      <ul className="album-list">
        <li className={filter.albumId === null ? 'selected' : ''}><button onClick={() => store.patchFilter({ albumId: null })}>All photos <span className="muted">{photos.length}</span></button></li>
        {albums.map((a) => (
          <li key={a.id} className={filter.albumId === a.id ? 'selected' : ''} data-album={a.id}>
            {editing === a.id ? (
              <input className="text" autoFocus aria-label="Album name" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { void store.renameAlbum(a.id, editName); setEditing(null); } if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} onBlur={() => setEditing(null)} />
            ) : (
              <button className="album-name" onClick={() => store.patchFilter({ albumId: filter.albumId === a.id ? null : a.id })} onDoubleClick={() => { setEditing(a.id); setEditName(a.name); }} title="Double-click to rename">{a.name} <span className="muted">{count(a.id)}</span></button>
            )}
            <button className="icon" title={`Add ${targets.length > 1 ? `${targets.length} photos` : 'this photo'} to ${a.name}`} aria-label={`Add to ${a.name}`} disabled={!targets.length} onClick={() => store.addToAlbum(a.id)}>＋</button>
            <button className="icon" title={`Remove from ${a.name}`} aria-label={`Remove from ${a.name}`} disabled={!targets.length} onClick={() => store.removeFromAlbum(a.id)}>−</button>
            <button className="icon" title="Delete album (photos are kept)" aria-label={`Delete album ${a.name}`} onClick={() => { if (confirm(`Delete album “${a.name}”? The photos stay in your library.`)) void store.deleteAlbum(a.id); }}>×</button>
          </li>
        ))}
      </ul>
      <form className="lib-block lib-row" onSubmit={(e) => { e.preventDefault(); void store.createAlbum(newName).then((id) => { if (id) { setNewName(''); if (selection.length || store.getState().currentId) store.addToAlbum(id); } }); }}>
        <input className="text" placeholder="New album…" aria-label="New album name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="tool" disabled={!newName.trim()} title="Create the album and add the selected photos">Create</button>
      </form>
    </div>
  );
}

export { Stars };
