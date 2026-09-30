import { store, useEditor } from './store';

export function Filmstrip() {
  const photos = useEditor((s) => s.photos);
  const currentId = useEditor((s) => s.currentId);
  return (
    <div className="filmstrip" role="listbox" aria-label="Photos">
      {photos.length === 0 && <div className="filmstrip-empty">No photos yet</div>}
      {photos.map((p) => (
        <button key={p.id} className={`thumb${p.id === currentId ? ' current' : ''}`} onClick={() => store.select(p.id)} role="option" aria-selected={p.id === currentId} title={`${p.name} — ${p.width}×${p.height}`}>
          {p.thumbUrl ? <img src={p.thumbUrl} alt={p.name} draggable={false} /> : <span>{p.name}</span>}
        </button>
      ))}
    </div>
  );
}
