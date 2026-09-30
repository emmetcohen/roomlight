import { useState } from 'react';
import { curvesAreIdentity } from '../image-engine/curves';
import { SLIDERS, isDefault, keysOfSection, type SectionId } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { LensPanel } from './CropPanel';
import { CurvePanel } from './CurvePanel';
import { DetailPanel } from './DetailPanel';
import { GradingPanel } from './GradingPanel';
import { MixerPanel } from './MixerPanel';
import { store, useEditor } from './store';

const sliders = (section: SectionId) => SLIDERS.filter((s) => s.section === section && !s.hidden).map((s) => <Slider key={s.key} param={s.key} />);
const keysOf = (...ids: SectionId[]) => ids.flatMap((id) => keysOfSection(id));

/** White balance: As Shot / Auto / Custom, plus the picker. */
function WhiteBalance() {
  const t = useEditor((s) => s.params.temperature), ti = useEditor((s) => s.params.tint);
  const eyedropper = useEditor((s) => s.eyedropper);
  const [auto, setAuto] = useState<{ t: number; ti: number } | null>(null);
  const value = t === 0 && ti === 0 ? 'asShot' : auto && auto.t === t && auto.ti === ti ? 'auto' : 'custom';
  const choose = (v: string) => {
    if (v === 'asShot') { store.resetKeys(['temperature', 'tint'], 'White Balance: As Shot'); setAuto(null); }
    else if (v === 'auto') { store.autoWhiteBalance(); const p = store.getState().params; setAuto({ t: p.temperature, ti: p.tint }); }
  };
  return (
    <>
      <div className="wb-tools">
        <select aria-label="White balance" data-testid="wb-select" value={value} onChange={(e) => choose(e.target.value)}>
          <option value="asShot">As Shot</option><option value="auto">Auto</option><option value="custom" disabled={value !== 'custom'}>Custom</option>
        </select>
        <button className={`tool${eyedropper ? ' on' : ''}`} onClick={() => store.toggleEyedropper()} title="Click a neutral grey/white area of the photo">◉ Pick neutral</button>
      </div>
      {sliders('whiteBalance')}
    </>
  );
}

/** The global editing panels, in Lightroom's order: Basic, Curve, Color Mixer, Color Grading, Detail, Optics, Effects. */
export function EditPanels() {
  const params = useEditor((s) => s.params);
  const basicKeys = keysOf('whiteBalance', 'tone', 'presence', 'color');
  const effectKeys = keysOf('vignette', 'grain');
  const curveDefault = curvesAreIdentity(params.curves) && isDefault(params, keysOfSection('curve'));
  return (
    <>
      <Panel title="Basic" onReset={() => store.resetKeys(basicKeys, 'Reset Basic')} resetDisabled={isDefault(params, basicKeys)}>
        <div className="subhead" style={{ marginTop: 0 }}>White Balance</div>
        <WhiteBalance />
        <div className="subhead">Tone</div>
        {sliders('tone')}
        <div className="subhead">Presence</div>
        {/* Texture, Clarity and Dehaze live here and only here; Vibrance and Saturation follow */}
        {sliders('presence')}
        {sliders('color')}
      </Panel>
      <Panel title="Curve" defaultOpen={false} onReset={() => store.resetSection('curve')} resetDisabled={curveDefault}><CurvePanel /></Panel>
      <Panel title="Color Mixer" defaultOpen={false} onReset={() => store.resetSection('mixer')} resetDisabled={isDefault(params, keysOfSection('mixer'))}><MixerPanel /></Panel>
      <Panel title="Color Grading" defaultOpen={false} onReset={() => store.resetSection('grading')} resetDisabled={isDefault(params, keysOfSection('grading'))}><GradingPanel /></Panel>
      <Panel title="Detail" defaultOpen={false} onReset={() => store.resetSection('detail')} resetDisabled={isDefault(params, keysOfSection('detail'))}><DetailPanel /></Panel>
      <Panel title="Optics" defaultOpen={false} onReset={() => store.resetSection('lens')} resetDisabled={isDefault(params, keysOfSection('lens')) && params.lensProfile === 'none'}><LensPanel /></Panel>
      <Panel title="Effects" defaultOpen={false} onReset={() => store.resetKeys(effectKeys, 'Reset Effects')} resetDisabled={isDefault(params, effectKeys)}>
        <div className="subhead" style={{ marginTop: 0 }}>Vignette</div>
        {sliders('vignette')}
        <div className="subhead">Grain</div>
        {sliders('grain')}
      </Panel>
    </>
  );
}
