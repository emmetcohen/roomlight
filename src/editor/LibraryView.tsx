import { useRef } from 'react';
import { filterIsActive } from '../library/types';
import { store, useEditor, type PhotoSummary } from './store';
import { Badges } from './Filmstrip';

/** Library view: a grid of every photo (after filters), with selection, ratings and flags. Double-click opens a photo in Edit. */
export function LibraryGrid({ onImport }: { onImport: () => void }) {
  const photos = useEditor((s) => s.photos);
  const visible = useEditor((s) => s.visible);
  const filter = useEditor((s) => s.filter);
  const currentId = useEditor((s) => s.currentId);
  const selection = useEditor((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const shown = visible.map((id) => byId.get(id)!).filter(Boolean) as PhotoSummary[];
  const targets = store.targets();
  const active = filterIsActive(filter);
  return (
    <div className="library-view">
      <div className="lib-toolbar">
        <button className="primary-sm" data-testid="import-btn" onClick={onImport}>Import…</button>
        <button className="tool" disabled={!currentId} data-testid="open-in-edit" onClick={() => currentId && void store.openInEdit(currentId)} title="Open the selected photo in Edit (Enter)">Open in Edit</button>
        <button className="tool danger" disabled={!targets.length} data-testid="remove-photos" onClick={() => { if (confirm(`Remove ${targets.length} photo${targets.length > 1 ? 's' : ''} and their edits from the library? The files on your disk are not touched.`)) for (const id of [...targets]) void store.removePhoto(id); }}>Remove{targets.length > 1 ? ` ${targets.length}` : ''}</button>
        <span className="spacer" />
        <span className="muted" data-testid="photo-count">{active ? `${shown.length} of ${photos.length} shown` : `${photos.length} photo${photos.length === 1 ? '' : 's'}`}{selection.length > 1 ? ` · ${selection.length} selected` : ''}</span>
        {active && <button className="link" onClick={store.clearFilter}>Clear filter</button>}
      </div>
      {photos.length === 0 ? (
        <div className="empty static">
          <h2>Drop photos here</h2>
          <p>JPEG, PNG and WebP are supported. Originals are stored untouched; edits are saved as parameters.</p>
          <button className="primary" onClick={onImport}>Import photos…</button>
        </div>
      ) : shown.length === 0 ? <div className="empty static"><p>No photos match this filter.</p></div> : (
        <div className="photo-grid" ref={ref} role="listbox" aria-label="Photos" aria-multiselectable="true">
          {shown.map((p) => {
            const selected = selection.includes(p.id);
            return (
              <button key={p.id} data-photo={p.id} data-rating={p.info.rating} data-flag={p.info.flag}
                className={`cell${p.id === currentId ? ' current' : ''}${selected ? ' selected' : ''}${p.info.flag === 'reject' ? ' rejected' : ''}`}
                role="option" aria-selected={p.id === currentId || selected}
                onClick={(e) => store.clickPhoto(p.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                onDoubleClick={() => void store.openInEdit(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') void store.openInEdit(p.id); }}
                title={`${p.name} — ${p.width}×${p.height}\nDouble-click to edit`}>
                {p.thumbUrl ? <img src={p.thumbUrl} alt={p.name} draggable={false} /> : <span>{p.name}</span>}
                <Badges p={p} />
                <span className="cell-name">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
