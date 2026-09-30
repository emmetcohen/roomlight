import { Panel } from '../ui/Panel';
import { SHORTCUTS } from '../utils/shortcuts';
import { HistoryPanel } from './HistoryPanel';
import { PresetsPanel } from './PresetsPanel';
import { SnapshotsPanel } from './SnapshotsPanel';

/** Edit view, left: Presets, History, Snapshots (and the shortcut list, collapsed). */
export function LeftPanel() {
  return (
    <>
      <PresetsPanel />
      <Panel title="History"><HistoryPanel /></Panel>
      <Panel title="Snapshots"><SnapshotsPanel /></Panel>
      <Panel title="Keyboard shortcuts" defaultOpen={false}>
        <ul className="shortcuts">
          {SHORTCUTS.map((s) => <li key={s.id}><span>{s.label}</span><kbd>{(s.display ?? s.keys[0]).replace('mod', '⌘/Ctrl').replace('arrowright', '→').replace('arrowleft', '←')}</kbd></li>)}
        </ul>
      </Panel>
    </>
  );
}
