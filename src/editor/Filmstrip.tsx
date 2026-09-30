import { COLOR_LABELS, LABEL_CSS, filterIsActive } from '../library/types';
import { store, useEditor, type PhotoSummary } from './store';

export function Badges({ p }: { p: PhotoSummary }) {
  const { rating, flag, label } = p.info;
  return (
    <>
      {label && <span className="t-label" style={{ background: LABEL_CSS[label] }} title={`Label: ${label}`} />}
      {flag !== 'none' && <span className={`t-flag ${flag}`} title={flag === 'pick' ? 'Picked' : 'Rejected'}>{flag === 'pick' ? '⚑' : '✕'}</span>}
      {rating > 0 && <span className="t-stars" title={`${rating} star${rating > 1 ? 's' : ''}`}>{'★'.repeat(rating)}</span>}
      {p.edited && <span className="t-edited" title="Has edits" />}
    </>
  );
}

export function Filmstrip() {
  const photos = useEditor((s) => s.photos);
  const visible = useEditor((s) => s.visible);
  const filter = useEditor((s) => s.filter);
  const currentId = useEditor((s) => s.currentId);
  const selection = useEditor((s) => s.selection);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const shown = visible.map((id) => byId.get(id)!).filter(Boolean);
  const active = filterIsActive(filter);
  return (
    <div className="filmstrip-wrap">
      <div className="filmstrip-info">
        {photos.length > 0 && <span data-testid="photo-count">{active ? `${shown.length} of ${photos.length} shown` : `${photos.length} photo${photos.length > 1 ? 's' : ''}`}</span>}
        {selection.length > 1 && <span className="sel-count" data-testid="selection-count">{selection.length} selected</span>}
        {active && <button className="link" onClick={store.clearFilter}>Clear filter</button>}
      </div>
      <div className="filmstrip" role="listbox" aria-label="Photos" aria-multiselectable="true">
        {photos.length === 0 && <div className="filmstrip-empty">No photos yet</div>}
        {photos.length > 0 && shown.length === 0 && <div className="filmstrip-empty">No photos match this filter.</div>}
        {shown.map((p) => {
          const selected = selection.includes(p.id);
          return (
            <button key={p.id} data-photo={p.id} data-rating={p.info.rating} data-flag={p.info.flag}
              className={`thumb${p.id === currentId ? ' current' : ''}${selected ? ' selected' : ''}${p.info.flag === 'reject' ? ' rejected' : ''}`}
              onClick={(e) => store.clickPhoto(p.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
              role="option" aria-selected={p.id === currentId || selected}
              title={`${p.name} — ${p.width}×${p.height}${p.info.title ? `\n${p.info.title}` : ''}`}>
              {p.thumbUrl ? <img src={p.thumbUrl} alt={p.name} draggable={false} /> : <span>{p.name}</span>}
              <Badges p={p} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { COLOR_LABELS };
