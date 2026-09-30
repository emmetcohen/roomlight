import { curvesAreIdentity } from '../image-engine/curves';
import { SECTIONS, SLIDERS, isDefault, keysOfSection, type SectionId } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { CurveEditor } from './CurveEditor';
import { GradingPanel } from './GradingPanel';
import { MixerPanel } from './MixerPanel';
import { store, useEditor } from './store';

const BASIC: SectionId[] = ['whiteBalance', 'tone', 'presence', 'color'];
const sectionLabel = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.label;

/** The whole right-hand editing column: Basic, Tone Curve, Color Mixer, Color Grading, Effects. */
export function EditPanels() {
  const params = useEditor((s) => s.params);
  const eyedropper = useEditor((s) => s.eyedropper);
  const reset = (id: SectionId) => ({ onReset: () => store.resetSection(id), resetDisabled: id === 'curve' ? curvesAreIdentity(params.curves) : isDefault(params, keysOfSection(id)) });
  return (
    <>
      {BASIC.map((id) => (
        <Panel key={id} title={sectionLabel(id)} {...reset(id)}>
          {id === 'whiteBalance' && (
            <div className="wb-tools">
              <button className={`tool${eyedropper ? ' on' : ''}`} onClick={() => store.toggleEyedropper()} title="Click a neutral grey/white area of the photo">◉ Pick neutral</button>
              <button className="tool" onClick={store.autoWhiteBalance} title="Estimate from the image (grey-world)">Auto</button>
            </div>
          )}
          {SLIDERS.filter((s) => s.section === id).map((s) => <Slider key={s.key} param={s.key} />)}
        </Panel>
      ))}
      <Panel title="Tone Curve" defaultOpen={false} {...reset('curve')}><CurveEditor /></Panel>
      <Panel title="Color Mixer" defaultOpen={false} {...reset('mixer')}><MixerPanel /></Panel>
      <Panel title="Color Grading" defaultOpen={false} {...reset('grading')}><GradingPanel /></Panel>
      <Panel title="Vignette" defaultOpen={false} {...reset('vignette')}>
        {SLIDERS.filter((s) => s.section === 'vignette').map((s) => <Slider key={s.key} param={s.key} />)}
      </Panel>
      <Panel title="Grain" defaultOpen={false} {...reset('grain')}>
        {SLIDERS.filter((s) => s.section === 'grain').map((s) => <Slider key={s.key} param={s.key} />)}
      </Panel>
    </>
  );
}

