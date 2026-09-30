import { store, useEditor } from './store';

export function HistoryPanel() {
  const history = useEditor((s) => s.history);
  if (!history) return <div className="muted small">Open a photo to see its edit history.</div>;
  const items = history.entries.map((e, i) => ({ e, i })).reverse();
  return (
    <ol className="history-list">
      {items.map(({ e, i }) => (
        <li key={i}>
          <button className={i === history.index && history.live === null ? 'current' : i > history.index ? 'future' : ''} onClick={() => store.jumpTo(i)}>
            {e.label}
          </button>
        </li>
      ))}
    </ol>
  );
}
