import type { ReactNode } from 'react';
import { linearToSrgb } from '../color/colorSpace';
import { SLIDER_BY_KEY } from '../image-engine/params';
import { oklabToLinear } from '../image-engine/oklab';
import { listSegmentationProviders } from '../masks/segmentation';
import { LOCAL_EXTRA, MAX_MASKS, SHAPE_LABEL, type LocalKey, type Mask, type MaskComponent, type MaskOp, type Shape } from '../masks/types';
import { Panel } from '../ui/Panel';
import { SliderView } from '../ui/Slider';
import { store, useEditor } from './store';

const ADJUST_GROUPS: { title: string; keys: LocalKey[] }[] = [
  { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Color', keys: ['temperature', 'tint', 'vibrance', 'saturation'] },
  { title: 'Effects', keys: ['texture', 'clarity', 'dehaze'] },
  { title: 'Detail', keys: ['sharpness', 'noise'] },
];

const CREATE: { type: Shape['type']; label: string; key: string }[] = [
  { type: 'brush', label: 'Brush', key: 'B' },
  { type: 'linear', label: 'Linear Gradient', key: 'L' },
  { type: 'radial', label: 'Radial Gradient', key: 'R' },
  { type: 'color', label: 'Color Range', key: '' },
  { type: 'luminance', label: 'Luminance Range', key: '' },
];

function LocalSlider({ mask, k }: { mask: Mask; k: LocalKey }) {
  const extra = LOCAL_EXTRA[k];
  const def = extra ? { label: extra.label, fullLabel: extra.label, min: extra.min, max: extra.max, step: 1, default: extra.default, decimals: 0, signed: extra.min < 0, track: undefined } : SLIDER_BY_KEY[k as keyof typeof SLIDER_BY_KEY];
  const label = `Adjust Mask ${def.label}`;
  return (
    <div data-local={k}>
      <SliderView
        label={def.label}
        ariaLabel={`Mask ${def.fullLabel}`}
        value={mask.adjust[k] ?? def.default}
        min={def.min} max={def.max} step={def.step} defaultValue={def.default} decimals={def.decimals} signed={def.signed} track={def.track}
        onPreview={(v) => store.previewLocal(mask.id, k, v)}
        onCommit={() => store.commitLocal(label)}
        onSet={(v) => store.setLocal(mask.id, k, v, label)}
        onReset={() => store.setLocal(mask.id, k, 0, `Reset Mask ${def.label}`)}
      />
    </div>
  );
}

/** Slider for a shape property: live preview while dragging, one history entry on release. */
function ShapeSlider(props: { mask: Mask; comp: MaskComponent; label: string; value: number; min: number; max: number; step?: number; def: number; decimals?: number; apply: (s: Shape, v: number) => Shape }) {
  const { mask, comp, apply } = props;
  const name = `Mask ${props.label}`;
  return (
    <div data-shape={props.label}>
      <SliderView
        label={props.label} ariaLabel={name} value={props.value} min={props.min} max={props.max} step={props.step ?? 1} defaultValue={props.def} decimals={props.decimals ?? 0} signed={false}
        onPreview={(v) => store.previewShape(mask.id, comp.id, (s) => apply(s, v))}
        onCommit={() => store.commitShape(`Adjust ${name}`)}
        onSet={(v) => { store.previewShape(mask.id, comp.id, (s) => apply(s, v)); store.commitShape(`Adjust ${name}`); }}
        onReset={() => { store.previewShape(mask.id, comp.id, (s) => apply(s, props.def)); store.commitShape(`Reset ${name}`); }}
      />
    </div>
  );
}

function BrushControls() {
  const brush = useEditor((s) => s.brush);
  const one = (label: string, key: 'size' | 'feather' | 'flow' | 'density', min = 0) => (
    <SliderView
      label={label} ariaLabel={`Brush ${label}`} value={brush[key]} min={min} max={100} step={1} defaultValue={key === 'size' ? 40 : key === 'feather' ? 50 : 100} signed={false}
      onPreview={(v) => store.setBrush({ [key]: v })} onCommit={() => undefined} onSet={(v) => store.setBrush({ [key]: v })} onReset={() => store.setBrush({ [key]: key === 'size' ? 40 : key === 'feather' ? 50 : 100 })}
    />
  );
  return (
    <>
      <div className="seg wide" role="group" aria-label="Brush mode">
        <button className={!brush.erase ? 'on' : ''} onClick={() => store.setBrush({ erase: false })}>Paint</button>
        <button className={brush.erase ? 'on' : ''} onClick={() => store.setBrush({ erase: true })}>Erase</button>
      </div>
      {one('Size', 'size', 1)}{one('Feather', 'feather')}{one('Flow', 'flow', 1)}{one('Density', 'density', 1)}
      <label className="chk" title="Auto Mask (edge-aware painting) is not built yet"><input type="checkbox" disabled data-testid="auto-mask" />Auto Mask <span className="muted small">(not available)</span></label>
      <p className="note">Paint on the photo. Pen pressure changes size and flow when your device reports it.</p>
    </>
  );
}

function ComponentSettings({ mask, comp }: { mask: Mask; comp: MaskComponent }) {
  const pickingColor = useEditor((s) => s.pickingColor);
  const s = comp.shape;
  switch (s.type) {
    case 'linear': {
      const angle = Math.round((Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI);
      return (
        <>
          <ShapeSlider mask={mask} comp={comp} label="Feather" value={s.feather} min={0} max={100} def={50} apply={(sh, v) => ({ ...(sh as typeof s), feather: v })} />
          <SliderView
            label="Rotation" ariaLabel="Mask Rotation" value={angle} min={-180} max={180} step={1} defaultValue={90} signed
            onPreview={(v) => store.previewShape(mask.id, comp.id, (sh) => rotateLine(sh as typeof s, v))} onCommit={() => store.commitShape('Rotate Linear Gradient')}
            onSet={(v) => { store.previewShape(mask.id, comp.id, (sh) => rotateLine(sh as typeof s, v)); store.commitShape('Rotate Linear Gradient'); }}
            onReset={() => { store.previewShape(mask.id, comp.id, (sh) => rotateLine(sh as typeof s, 90)); store.commitShape('Reset Gradient Rotation'); }}
          />
          <p className="note">Full effect at the filled handle, none at the hollow one. Drag the handles or the line on the photo.</p>
        </>
      );
    }
    case 'radial':
      return (
        <>
          <ShapeSlider mask={mask} comp={comp} label="Feather" value={s.feather} min={0} max={100} def={50} apply={(sh, v) => ({ ...(sh as typeof s), feather: v })} />
          <ShapeSlider mask={mask} comp={comp} label="Width" value={+(s.rx * 200).toFixed(1)} min={1} max={200} step={0.5} def={50} decimals={1} apply={(sh, v) => ({ ...(sh as typeof s), rx: v / 200 })} />
          <ShapeSlider mask={mask} comp={comp} label="Height" value={+(s.ry * 200).toFixed(1)} min={1} max={200} step={0.5} def={50} decimals={1} apply={(sh, v) => ({ ...(sh as typeof s), ry: v / 200 })} />
          <ShapeSlider mask={mask} comp={comp} label="Rotation" value={Math.round(s.rotation)} min={-180} max={180} def={0} apply={(sh, v) => ({ ...(sh as typeof s), rotation: v })} />
          <p className="note">Width and height are a percentage of the photo's long edge. Use "Invert" on the component to affect the outside.</p>
        </>
      );
    case 'brush':
      return (
        <>
          <BrushControls />
          <button className="tool" disabled={s.strokes.length === 0} onClick={() => { store.previewShape(mask.id, comp.id, (sh) => ({ ...(sh as typeof s), strokes: [] })); store.commitShape('Clear Brush Strokes'); }}>Clear strokes</button>
        </>
      );
    case 'color': {
      const lin = oklabToLinear([s.L, s.a, s.b]);
      const css = `rgb(${[0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, linearToSrgb(lin[i]))) * 255)).join(',')})`;
      return (
        <>
          <div className="color-target">
            <span className="swatch big" style={{ background: css }} data-testid="color-target" />
            <button className={`tool${pickingColor ? ' on' : ''}`} onClick={() => store.setPickingColor(!pickingColor)}>{pickingColor ? 'Click the photo…' : '◉ Pick color from photo'}</button>
          </div>
          <ShapeSlider mask={mask} comp={comp} label="Range" value={s.range} min={0} max={100} def={40} apply={(sh, v) => ({ ...(sh as typeof s), range: v })} />
          <p className="note">Selects colours similar to the target, fading out smoothly. A larger range includes more.</p>
        </>
      );
    }
    case 'luminance':
      return (
        <>
          <div className="lum-bar" style={{ background: `linear-gradient(90deg, #000 ${Math.max(0, s.min - s.smooth * 0.25)}%, #ffb13d ${s.min + s.smooth * 0.25}%, #ffb13d ${Math.max(s.min, s.max - s.smooth * 0.25)}%, #000 ${Math.min(100, s.max + s.smooth * 0.25)}%)` }} aria-hidden />
          <ShapeSlider mask={mask} comp={comp} label="Min" value={s.min} min={0} max={100} def={65} apply={(sh, v) => ({ ...(sh as typeof s), min: Math.min(v, (sh as typeof s).max) })} />
          <ShapeSlider mask={mask} comp={comp} label="Max" value={s.max} min={0} max={100} def={100} apply={(sh, v) => ({ ...(sh as typeof s), max: Math.max(v, (sh as typeof s).min) })} />
          <ShapeSlider mask={mask} comp={comp} label="Smoothness" value={s.smooth} min={0} max={100} def={30} apply={(sh, v) => ({ ...(sh as typeof s), smooth: v })} />
          <p className="note">Affects tones between Min and Max (as a percentage of brightness in the original photo).</p>
        </>
      );
    case 'segment':
      return <p className="note">Selection from a segmentation provider ({s.kind}).</p>;
  }
}

/** Rotate a gradient line about its midpoint so it points `deg` degrees (0 = right, 90 = down). */
function rotateLine(s: Extract<Shape, { type: 'linear' }>, deg: number): Shape {
  const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2, half = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / 2;
  const t = (deg * Math.PI) / 180;
  return { ...s, x1: mx - Math.cos(t) * half, y1: my - Math.sin(t) * half, x2: mx + Math.cos(t) * half, y2: my + Math.sin(t) * half };
}

const OPS: { op: MaskOp; label: string }[] = [{ op: 'add', label: 'Add' }, { op: 'subtract', label: 'Subtract' }, { op: 'intersect', label: 'Intersect' }];

function ComponentRow({ mask, comp, index }: { mask: Mask; comp: MaskComponent; index: number }) {
  const selected = useEditor((s) => s.selectedComp === comp.id);
  return (
    <li className={`comp-row${selected ? ' selected' : ''}`} data-comp={comp.shape.type}>
      <button className="comp-name" onClick={() => store.selectComp(mask.id, comp.id)}>{SHAPE_LABEL[comp.shape.type]}</button>
      {index > 0 ? (
        <select aria-label="Combine with previous" value={comp.op} onChange={(e) => store.setComponentMeta(mask.id, comp.id, { op: e.target.value as MaskOp }, 'Change Mask Operation')}>
          {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
        </select>
      ) : comp.op !== 'add' ? (
        <select aria-label="Combine" value={comp.op} onChange={(e) => store.setComponentMeta(mask.id, comp.id, { op: e.target.value as MaskOp }, 'Change Mask Operation')}>
          {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
        </select>
      ) : <span className="muted small">base</span>}
      <label className="chk" title="Invert this component"><input type="checkbox" checked={comp.invert} onChange={(e) => store.setComponentMeta(mask.id, comp.id, { invert: e.target.checked }, 'Invert Mask Component')} />Inv</label>
      <button className="icon" aria-label="Delete component" title="Delete component" onClick={() => store.removeComponent(mask.id, comp.id)}>×</button>
    </li>
  );
}

function MaskDetails({ mask }: { mask: Mask }) {
  const comp = useEditor((s) => mask.components.find((c) => c.id === s.selectedComp) ?? mask.components[0]);
  const showOverlay = useEditor((s) => s.showOverlay);
  const anyAdjust = Object.keys(mask.adjust).length > 0;
  return (
    <>
      <Panel title="Mask" >
        <div className="mask-name-row">
          <input aria-label="Mask name" className="text" value={mask.name} onChange={(e) => store.updateMaskMeta(mask.id, { name: e.target.value }, 'Rename Mask')} />
        </div>
        <ul className="comp-list">{mask.components.map((c, i) => <ComponentRow key={c.id} mask={mask} comp={c} index={i} />)}</ul>
        <AddComponent />
        <div className="mask-flags">
          <label className="chk"><input type="checkbox" checked={mask.invert} onChange={(e) => store.updateMaskMeta(mask.id, { invert: e.target.checked }, 'Invert Mask')} />Invert mask</label>
          <label className="chk"><input type="checkbox" checked={showOverlay} onChange={store.toggleOverlay} />Show overlay</label>
        </div>
        <SliderView
          label="Amount" ariaLabel="Mask Amount" value={mask.amount} min={0} max={100} step={1} defaultValue={100} signed={false}
          onPreview={(v) => store.previewMaskMeta(mask.id, { amount: v })} onCommit={() => store.commitLocal('Adjust Mask Amount')}
          onSet={(v) => store.updateMaskMeta(mask.id, { amount: v }, 'Adjust Mask Amount')} onReset={() => store.updateMaskMeta(mask.id, { amount: 100 }, 'Reset Mask Amount')}
        />
      </Panel>
      {comp && <Panel title={`${SHAPE_LABEL[comp.shape.type]} settings`}><ComponentSettings mask={mask} comp={comp} /></Panel>}
      {ADJUST_GROUPS.map((g) => (
        <Panel key={g.title} title={g.title} defaultOpen={g.title !== 'Detail'}>
          {g.keys.map((k) => <LocalSlider key={k} mask={mask} k={k} />)}
        </Panel>
      ))}
      <div className="pad"><button className="tool" disabled={!anyAdjust} onClick={() => store.resetMaskAdjust(mask.id)}>Reset adjustments</button></div>
    </>
  );
}

function AddComponent() {
  const types: Shape['type'][] = ['brush', 'linear', 'radial', 'color', 'luminance'];
  return (
    <div className="add-comp">
      <div className="muted small">Combine with another shape</div>
      {OPS.map((o) => (
        <div key={o.op} className="add-row">
          <span>{o.label}</span>
          {types.map((t) => <button key={t} className="tool" title={`${o.label}: ${SHAPE_LABEL[t]}`} data-add={`${o.op}:${t}`} onClick={() => store.addComponent(t, o.op)}>{SHAPE_LABEL[t].split(' ')[0]}</button>)}
        </div>
      ))}
    </div>
  );
}

export function MaskPanel() {
  const masks = useEditor((s) => s.params.masks);
  const selected = useEditor((s) => s.selectedMask);
  const mask = masks.find((m) => m.id === selected);
  const haveProvider = listSegmentationProviders().length > 0;
  const unavailable: { id: string; label: string; why: string }[] = [
    { id: 'objects', label: 'Objects', why: 'Needs a segmentation model (none is installed)' },
    { id: 'depth', label: 'Depth Range', why: 'Needs depth information (none is available for JPEG/PNG/WebP files)' },
  ];
  const ai: { kind: 'subject' | 'sky' | 'background'; label: string }[] = [{ kind: 'subject', label: 'Subject' }, { kind: 'sky', label: 'Sky' }, { kind: 'background', label: 'Background' }];
  const row = (children: ReactNode) => <div className="create-grid">{children}</div>;
  return (
    <>
      <Panel title="Create New Mask">
        {row(CREATE.map((c) => (
          <button key={c.type} className="create-btn" data-create={c.type} onClick={() => store.createMask(c.type)} title={c.key ? `${c.label} (${c.key})` : c.label}>{c.label}{c.key && <kbd>{c.key}</kbd>}</button>
        )))}
        {row(ai.map((a) => (
          <button key={a.kind} className="create-btn" data-create={a.kind} disabled={!haveProvider} onClick={() => store.createSegmentMask(a.kind)}
            title={haveProvider ? `Select ${a.label.toLowerCase()}` : 'Unavailable: no segmentation model is installed'}>{a.label}</button>
        )))}
        {row(unavailable.map((u) => <button key={u.id} className="create-btn" data-create={u.id} disabled title={u.why}>{u.label}</button>))}
        {!haveProvider && <p className="note" data-testid="ai-unavailable">Subject, Sky and Background selection need a segmentation model. None is installed in this build, so they are unavailable rather than faked. The plug-in interface is ready (see docs).</p>}
      </Panel>
      <Panel title={`Masks (${masks.length}/${MAX_MASKS})`}>
        {masks.length === 0 && <p className="note">No masks yet. Create one above, then adjust only that area.</p>}
        <ul className="mask-list">
          {masks.map((m) => (
            <li key={m.id} className={`mask-row${m.id === selected ? ' selected' : ''}${m.enabled ? '' : ' off'}`} data-mask={m.id}>
              <button className="icon" aria-label={m.enabled ? 'Hide mask' : 'Show mask'} title={m.enabled ? 'Disable mask' : 'Enable mask'} onClick={() => store.updateMaskMeta(m.id, { enabled: !m.enabled }, m.enabled ? 'Disable Mask' : 'Enable Mask')}>{m.enabled ? '◉' : '○'}</button>
              <button className="mask-name" onClick={() => store.selectMask(m.id)}>{m.name}</button>
              <button className="icon" aria-label="Duplicate mask" title="Duplicate" onClick={() => store.duplicateMask(m.id)}>⧉</button>
              <button className="icon" aria-label="Delete mask" title="Delete mask" onClick={() => store.removeMask(m.id)}>×</button>
            </li>
          ))}
        </ul>
      </Panel>
      {mask ? <MaskDetails key={mask.id} mask={mask} /> : masks.length > 0 && <p className="note pad">Select a mask to edit it.</p>}
    </>
  );
}
