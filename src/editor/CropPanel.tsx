import { useState } from 'react';
import { ASPECT_PRESETS, presetRatio } from '../geometry/crop';
import { canvasDims, outputSize } from '../geometry/transform';
import { listLensProfiles, NO_PROFILE } from '../lens/profiles';
import { SLIDERS, isDefault, keysOfSection } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { store, useEditor } from './store';

/** Right-hand column of the Crop tool. */
export function CropPanel() {
  const params = useEditor((s) => s.params);
  const photo = useEditor((s) => s.photos.find((p) => p.id === s.currentId));
  const [cw, setCw] = useState('7'), [ch, setCh] = useState('5');
  const crop = params.crop;
  const ow = photo?.width ?? 1, oh = photo?.height ?? 1;
  const out = outputSize(params, ow, oh);
  const canvas = canvasDims(ow, oh, params.orientation);
  const ratio = presetRatio(crop, canvas.w / canvas.h);
  const applyCustom = (w: string, h: string) => {
    const W = parseFloat(w), H = parseFloat(h);
    if (W > 0 && H > 0) store.setAspectPreset('custom', { w: W, h: H });
  };
  return (
    <>
      <Panel title="Crop">
        <div className="aspect-grid" role="group" aria-label="Aspect ratio">
          {ASPECT_PRESETS.map((a) => (
            <button key={a.id} data-aspect={a.id} className={`tool${crop.aspect === a.id ? ' on' : ''}`} onClick={() => (a.id === 'custom' ? applyCustom(cw, ch) : store.setAspectPreset(a.id))}>{a.label}</button>
          ))}
        </div>
        {crop.aspect === 'custom' && (
          <div className="custom-ratio">
            <input aria-label="Custom ratio width" className="text num" value={cw} onChange={(e) => { setCw(e.target.value); applyCustom(e.target.value, ch); }} />
            <span>:</span>
            <input aria-label="Custom ratio height" className="text num" value={ch} onChange={(e) => { setCh(e.target.value); applyCustom(cw, e.target.value); }} />
          </div>
        )}
        <div className="row-buttons">
          <button className="tool" disabled={ratio === null || crop.aspect === 'original' || crop.aspect === '1:1'} onClick={store.swapAspect} title="Swap landscape / portrait">⇄ Orientation</button>
          <button className="tool" disabled={crop.aspect === 'free'} onClick={() => store.setAspectPreset('free')} title="Unlock the aspect ratio">Unlock</button>
        </div>
        <div className="readout" data-testid="crop-size">{out.w} × {out.h} px{ratio ? ` · ${ratio.toFixed(3)}:1` : ' · free'}</div>
        <p className="note">Cropping only changes four numbers. The original pixels are kept, so you can re-crop any time.</p>
      </Panel>
      <Panel title="Rotate &amp; Flip">
        <div className="row-buttons">
          <button className="tool" onClick={() => store.rotate90(-1)} title="Rotate left 90°">⟲ Left</button>
          <button className="tool" onClick={() => store.rotate90(1)} title="Rotate right 90°">⟳ Right</button>
          <button className="tool" onClick={() => store.flip('h')} title="Flip horizontally">⇋ Flip H</button>
          <button className="tool" onClick={() => store.flip('v')} title="Flip vertically">⥮ Flip V</button>
        </div>
      </Panel>
      <Panel title="Angle" onReset={() => store.resetParam('straighten')} resetDisabled={params.straighten === 0}>
        {SLIDERS.filter((s) => s.section === 'crop' && !s.hidden).map((s) => <Slider key={s.key} param={s.key} />)}
        <div className="row-buttons">
          <button className="tool" onClick={() => store.autoUpright('level')} title="Level the horizon from detected straight lines">Auto level</button>
        </div>
        <p className="note">Straightening shrinks the crop automatically so no empty corners show.</p>
      </Panel>
      <div className="pad row-buttons">
        <button className="tool" disabled={isDefault(params, keysOfSection('crop')) && crop.w === 1 && crop.h === 1 && crop.aspect === 'free'} onClick={store.resetCropTool}>Reset crop</button>
        <button className="primary-sm" onClick={() => store.setTool('edit')}>Done</button>
      </div>
    </>
  );
}

/** Upright + perspective sliders (Edit tool). */
export function GeometryPanel() {
  return (
    <>
      <div className="upright" role="group" aria-label="Upright">
        <span className="muted small">Upright</span>
        <button className="tool" data-upright="off" onClick={() => store.resetKeys(['geoVertical', 'geoHorizontal', 'geoRotate'], 'Upright Off')} title="Clear perspective">Off</button>
        <button className="tool" data-upright="level" onClick={() => store.autoUpright('level')} title="Level only">Level</button>
        <button className="tool" data-upright="vertical" onClick={() => store.autoUpright('vertical')} title="Fix vertical convergence">Vertical</button>
        <button className="tool" data-upright="auto" onClick={() => store.autoUpright('auto')} title="Level + vertical">Auto</button>
        <button className="tool" data-upright="full" onClick={() => store.autoUpright('full')} title="Level + vertical + horizontal">Full</button>
      </div>
      {SLIDERS.filter((s) => s.section === 'geometry').map((s) => <Slider key={s.key} param={s.key} />)}
      <p className="note">Upright looks for long straight edges and finds the transform that makes them vertical and horizontal. If it finds none it says so and changes nothing. The crop shrinks to hide empty edges; use Reset crop in the Crop tool to restore the framing.</p>
    </>
  );
}

/** Lens profile + manual corrections (Edit tool). */
export function LensPanel() {
  const profile = useEditor((s) => s.params.lensProfile);
  const profiles = listLensProfiles();
  return (
    <>
      <label className="field">
        <span className="muted small">Profile</span>
        <select aria-label="Lens profile" value={profile} onChange={(e) => store.setLensProfile(e.target.value)}>
          <option value={NO_PROFILE}>None (manual only)</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.example ? ' (example)' : ''}</option>)}
        </select>
      </label>
      {profiles.some((p) => p.id === profile && p.example) && <p className="note" data-testid="example-profile-note">Example profiles are illustrative numbers, not measured from a real lens. Roomlight ships no lens database; real profiles can be registered (see docs).</p>}
      {SLIDERS.filter((s) => s.section === 'lens').map((s) => <Slider key={s.key} param={s.key} />)}
      <p className="note">Corrections add to the selected profile. Distortion + corrects barrel, − corrects pincushion.</p>
    </>
  );
}
