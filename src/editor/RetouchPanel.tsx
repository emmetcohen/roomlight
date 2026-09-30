import { MAX_SPOTS, SPOT_KIND_LABEL, type SpotKind } from '../retouch/types';
import { Panel } from '../ui/Panel';
import { SliderView } from '../ui/Slider';
import { store, useEditor } from './store';

const KINDS: { kind: SpotKind; hint: string }[] = [
  { kind: 'heal', hint: 'Copies texture from the source circle and matches its colour and brightness to the surroundings.' },
  { kind: 'clone', hint: 'Copies the source circle exactly as it is.' },
  { kind: 'remove', hint: 'Heal with the source chosen for you: Roomlight searches this photo for the best-matching nearby patch.' },
];

/** Right-hand column of the Retouch tool. */
export function RetouchPanel() {
  const spots = useEditor((s) => s.params.spots);
  const selected = useEditor((s) => s.selectedSpot);
  const r = useEditor((s) => s.retouch);
  const showOverlay = useEditor((s) => s.showOverlay);
  const sources = store.spotSources();
  const one = (label: string, key: 'size' | 'feather' | 'opacity', min: number, def: number) => (
    <div data-retouch={key}>
      <SliderView
        label={label} ariaLabel={`Spot ${label}`} value={r[key]} min={min} max={100} step={1} defaultValue={def} signed={false}
        onPreview={(v) => store.previewRetouchControl(key, v)} onCommit={() => store.commitRetouchControl()}
        onSet={(v) => store.setRetouch({ [key]: v })} onReset={() => store.setRetouch({ [key]: def })}
      />
    </div>
  );
  const failed = spots.filter((s) => s.kind === 'remove' && s.enabled && sources.get(s.id)?.ok === false).length;
  return (
    <>
      <Panel title="Retouch">
        <div className="seg wide" role="group" aria-label="Spot type">
          {KINDS.map((k) => <button key={k.kind} data-spot-kind={k.kind} className={r.kind === k.kind ? 'on' : ''} title={k.hint} onClick={() => store.setRetouch({ kind: k.kind })}>{SPOT_KIND_LABEL[k.kind]}</button>)}
        </div>
        <p className="note" data-testid="spot-kind-hint">{KINDS.find((k) => k.kind === r.kind)!.hint}</p>
        {one('Size', 'size', 1, 30)}{one('Feather', 'feather', 0, 40)}{one('Opacity', 'opacity', 1, 100)}
        <div className="mask-flags"><label className="chk"><input type="checkbox" checked={showOverlay} onChange={store.toggleOverlay} />Show spots</label></div>
        <p className="note">Click the photo to add a spot. Drag a circle to move it; for Clone and Heal drag the dashed circle to choose the source. Retouching is saved as a list of spots, so it can always be edited or removed — the original is never changed.</p>
        {failed > 0 && <p className="note warn" data-testid="remove-failed">{failed === 1 ? 'One Remove spot' : `${failed} Remove spots`} could not find a matching patch that fits inside the picture, so nothing was changed there. Use Heal or Clone and pick a source by hand.</p>}
      </Panel>
      <Panel title={`Spots (${spots.length}/${MAX_SPOTS})`} onReset={store.clearSpots} resetDisabled={spots.length === 0}>
        {spots.length === 0 && <p className="note">No spots yet.</p>}
        <ul className="mask-list">
          {spots.map((s, i) => (
            <li key={s.id} className={`mask-row${s.id === selected ? ' selected' : ''}${s.enabled ? '' : ' off'}`} data-spot-row={s.id}>
              <button className="icon" aria-label={s.enabled ? 'Disable spot' : 'Enable spot'} title={s.enabled ? 'Disable' : 'Enable'} onClick={() => store.setSpotEnabled(s.id, !s.enabled)}>{s.enabled ? '◉' : '○'}</button>
              <button className="mask-name" onClick={() => store.selectSpot(s.id)}>{SPOT_KIND_LABEL[s.kind]} {i + 1}</button>
              <button className="icon" aria-label="Delete spot" title="Delete spot" onClick={() => store.removeSpot(s.id)}>×</button>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="pad row-buttons">
        <button className="primary-sm" onClick={() => store.setTool('edit')}>Done</button>
      </div>
    </>
  );
}
