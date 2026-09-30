import { useState } from 'react';
import { ASPECT_PRESETS, presetRatio } from '../geometry/crop';
import { canvasDims, outputSize } from '../geometry/transform';
import { listLensProfiles, NO_PROFILE } from '../lens/profiles';
import { SLIDERS, isDefault, keysOfSection } from '../image-engine/params';
import { Panel } from '../ui/Panel';
import { Slider } from '../ui/Slider';
import { store, useEditor } from './store';

const SLIDERS_OF = (section: 'crop' | 'geometry' | 'lens') => SLIDERS.filter((s) => s.section === section && !s.hidden);

/** Crop tab: aspect, lock, orientation, rotate/flip, guides, straighten. */
function CropTab() {
  const params = useEditor((s) => s.params);
  const photo = useEditor((s) => s.photos.find((p) => p.id === s.currentId));
  const guides = useEditor((s) => s.cropGuides);
  const straightenTool = useEditor((s) => s.straightenTool);
  const [cw, setCw] = useState('7'), [ch, setCh] = useState('5');
  const crop = params.crop;
  const ow = photo?.width ?? 1, oh = photo?.height ?? 1;
  const out = outputSize(params, ow, oh);
  const canvas = canvasDims(ow, oh, params.orientation);
  const ratio = presetRatio(crop, canvas.w / canvas.h);
  const locked = crop.aspect !== 'free';
  const applyCustom = (w: string, h: string) => {
    const W = parseFloat(w), H = parseFloat(h);
    if (W > 0 && H > 0) store.setAspectPreset('custom', { w: W, h: H });
  };
  // Lock: keep the crop's CURRENT proportions; Unlock: back to free.
  const toggleLock = () => (locked ? store.setAspectPreset('free') : store.setAspectPreset('custom', { w: Math.max(1, Math.round(crop.w * canvas.w)), h: Math.max(1, Math.round(crop.h * canvas.h)) }));
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
          <button className={`tool${locked ? ' on' : ''}`} data-testid="lock-aspect" aria-pressed={locked} onClick={toggleLock} title={locked ? 'Aspect is locked — click to unlock' : 'Lock the current proportions'}>{locked ? '🔒 Locked' : '🔓 Lock aspect'}</button>
          <button className="tool" disabled={ratio === null || crop.aspect === 'original' || crop.aspect === '1:1'} onClick={store.swapAspect} title="Swap landscape / portrait">⇄ Orientation</button>
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
      <Panel title="Overlay">
        <div className="seg wide" role="group" aria-label="Crop guides">
          {(['none', 'thirds', 'grid'] as const).map((g) => <button key={g} data-guides={g} className={guides === g ? 'on' : ''} onClick={() => store.setCropGuides(g)}>{g === 'none' ? 'None' : g === 'thirds' ? 'Rule of thirds' : 'Grid'}</button>)}
        </div>
      </Panel>
      <Panel title="Angle" onReset={() => store.resetParam('straighten')} resetDisabled={params.straighten === 0}>
        {SLIDERS_OF('crop').map((s) => <Slider key={s.key} param={s.key} />)}
        <div className="row-buttons">
          <button className="tool" data-testid="auto-straighten" onClick={() => store.autoUpright('level')} title="Level the horizon from detected straight lines">Auto</button>
          <button className={`tool${straightenTool ? ' on' : ''}`} data-testid="straighten-tool" aria-pressed={straightenTool} onClick={store.toggleStraightenTool} title="Draw a line along the horizon or an edge on the photo">⟋ Straighten tool</button>
        </div>
        {straightenTool && <p className="note" data-testid="straighten-hint">Drag a line along something that should be level or upright.</p>}
        <p className="note">Straightening shrinks the crop automatically so no empty corners show (turn that off in Geometry → Constrain Crop).</p>
      </Panel>
    </>
  );
}

/** Geometry tab: Upright and Transform (moved here from the Edit panels). */
function GeometryTab() {
  const params = useEditor((s) => s.params);
  const constrain = useEditor((s) => s.constrainCrop);
  return (
    <>
      <Panel title="Upright">
        <div className="upright" role="group" aria-label="Upright">
          <button className="tool" data-upright="off" onClick={() => store.resetKeys(['geoVertical', 'geoHorizontal', 'geoRotate'], 'Upright Off')} title="Clear perspective">Off</button>
          <button className="tool" data-upright="auto" onClick={() => store.autoUpright('auto')} title="Level + vertical">Auto</button>
          <button className="tool" data-upright="level" onClick={() => store.autoUpright('level')} title="Level only">Level</button>
          <button className="tool" data-upright="vertical" onClick={() => store.autoUpright('vertical')} title="Fix vertical convergence">Vertical</button>
          <button className="tool" data-upright="full" onClick={() => store.autoUpright('full')} title="Level + vertical + horizontal">Full</button>
          <button className="tool" data-upright="guided" disabled title="Guided Upright (draw guide lines yourself) is not built yet">Guided</button>
        </div>
        <p className="note">Upright looks for long straight edges and finds the transform that makes them vertical and horizontal. If it finds none it says so and changes nothing. Guided (your own guide lines) is not available yet.</p>
      </Panel>
      <Panel title="Transform" onReset={() => store.resetSection('geometry')} resetDisabled={isDefault(params, keysOfSection('geometry'))}>
        {SLIDERS_OF('geometry').map((s) => <Slider key={s.key} param={s.key} />)}
        <label className="chk" style={{ marginTop: 8 }}><input type="checkbox" data-testid="constrain-crop" checked={constrain} onChange={(e) => store.setConstrainCrop(e.target.checked)} />Constrain Crop</label>
        <p className="note">With Constrain Crop on, the crop shrinks automatically to hide empty edges (it does not grow back; use Reset crop in the Crop tab). Off leaves the crop alone, so transparent corners can show. Geometry “Rotate” is separate from the Crop tab’s Angle; both apply.</p>
      </Panel>
    </>
  );
}

/** The Crop & Geometry tool: one tool, two sub-tabs. */
export function CropTool() {
  const tab = useEditor((s) => s.cropTab);
  const params = useEditor((s) => s.params);
  const crop = params.crop;
  return (
    <>
      <div className="seg wide crop-tabs" role="tablist" aria-label="Crop and geometry">
        <button role="tab" aria-selected={tab === 'crop'} data-crop-tab="crop" className={tab === 'crop' ? 'on' : ''} onClick={() => store.setCropTab('crop')}>Crop</button>
        <button role="tab" aria-selected={tab === 'geometry'} data-crop-tab="geometry" className={tab === 'geometry' ? 'on' : ''} onClick={() => store.setCropTab('geometry')}>Geometry</button>
      </div>
      {tab === 'crop' ? <CropTab /> : <GeometryTab />}
      <div className="pad row-buttons">
        {tab === 'crop' && <button className="tool" disabled={isDefault(params, keysOfSection('crop')) && crop.w === 1 && crop.h === 1 && crop.aspect === 'free'} onClick={store.resetCropTool}>Reset crop</button>}
        <button onClick={store.cancelCrop} title="Undo everything done since this tool was opened" data-testid="crop-cancel">Cancel</button>
        <button className="primary-sm" data-testid="crop-done" onClick={() => store.setTool('edit')}>Done</button>
      </div>
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
      {SLIDERS_OF('lens').map((s) => <Slider key={s.key} param={s.key} />)}
      <p className="note">Corrections add to the selected profile. Distortion + corrects barrel, − corrects pincushion. The chromatic aberration slider shifts red/blue by hand; an automatic “Remove Chromatic Aberration”, Defringe and a camera make/model database are not built.</p>
    </>
  );
}
