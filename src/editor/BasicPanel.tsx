import { SECTIONS, SLIDERS, isDefault, keysOfSection } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { store, useEditor } from './store';

export function BasicPanel() {
  const params = useEditor((s) => s.params);
  const eyedropper = useEditor((s) => s.eyedropper);
  return (
    <>
      {SECTIONS.map((sec) => (
        <Panel key={sec.id} title={sec.label} onReset={() => store.resetSection(sec.id)} resetDisabled={isDefault(params, keysOfSection(sec.id))}>
          {sec.id === 'whiteBalance' && (
            <div className="wb-tools">
              <button className={`tool${eyedropper ? ' on' : ''}`} onClick={() => store.toggleEyedropper()} title="Click a neutral grey/white area of the photo">
                ◉ Pick neutral
              </button>
              <button className="tool" onClick={store.autoWhiteBalance} title="Estimate from the image (grey-world)">Auto</button>
            </div>
          )}
          {SLIDERS.filter((s) => s.section === sec.id).map((s) => <Slider key={s.key} param={s.key} />)}
        </Panel>
      ))}
    </>
  );
}
