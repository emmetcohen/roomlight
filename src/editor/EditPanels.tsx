import { curvesAreIdentity } from '../image-engine/curves';
import { SECTIONS, SLIDERS, isDefault, keysOfSection, type SectionId } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { GeometryPanel, LensPanel } from './CropPanel';
import { CurveEditor } from './CurveEditor';
import { GradingPanel } from './GradingPanel';
import { MixerPanel } from './MixerPanel';
import { PresetsPanel } from './PresetsPanel';
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
      <PresetsPanel />
      {BASIC.map((id) => (
        <Panel key={id} title={sectionLabel(id)} {...reset(id)}>
          {id === 'whiteBalance' && (
            <div className="wb-tools">
              <button className={`tool${eyedropper ? ' on' : ''}`} onClick={() => store.toggleEyedropper()} title="Click a neutral grey/white area of the photo">◉ Pick neutral</button>
              <button className="tool" onClick={store.autoWhiteBalance} title="Estimate from the image (grey-world)">Auto</button>
            </div>
          )}
          {id === 'tone' && (
            <div className="wb-tools">
              <button className="tool" data-testid="auto-tone" onClick={store.autoTone} title="Set exposure, contrast, highlights, shadows, whites and blacks from the photo's histogram (a heuristic, not AI)">Auto tone</button>
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
      <Panel title="Geometry" defaultOpen={false} {...reset('geometry')}><GeometryPanel /></Panel>
      <Panel title="Lens Corrections" defaultOpen={false} onReset={() => store.resetSection('lens')} resetDisabled={isDefault(params, keysOfSection('lens')) && params.lensProfile === 'none'}><LensPanel /></Panel>
    </>
  );
}

