import { useEffect, useMemo, useRef, useState } from 'react';
import { linearToSrgb } from '../color/colorSpace';
import { SLIDER_BY_KEY } from '../image-engine/params';
import { oklabToLinear } from '../image-engine/oklab';
import { listSegmentationProviders } from '../masks/segmentation';
import { LOCAL_EXTRA, MAX_MASKS, SHAPE_LABEL, spanOf, type LocalKey, type Mask, type MaskComponent, type MaskOp, type Shape } from '../masks/types';
import { maskPreview } from '../masks/preview';
import { srgbToLinear } from '../color/colorSpace';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Panel } from '../ui/Panel';
import { SliderView } from '../ui/Slider';
import { store, useEditor } from './store';

const ADJUST_GROUPS: { title: string; keys: LocalKey[] }[] = [
  { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  { title: 'Color', keys: ['temperature', 'tint', 'vibrance', 'saturation'] },
  { title: 'Effects', keys: ['texture', 'clarity', 'dehaze'] },
  { title: 'Detail', keys: ['sharpness', 'noise'] },
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

const OPS: { op: MaskOp; label: string; icon: string }[] = [{ op: 'add', label: 'Add', icon: '＋' }, { op: 'subtract', label: 'Subtract', icon: '⊖' }, { op: 'intersect', label: 'Intersect', icon: '∩' }];
const OP_ICON: Record<MaskOp, string> = { add: '', subtract: '⊖', intersect: '∩' };
const SHAPES: Shape['type'][] = ['brush', 'linear', 'radial', 'color', 'luminance'];
const SHAPE_NAME: Record<Shape['type'], string> = { ...SHAPE_LABEL };

/** The list thumbnail: white where the mask applies. Drawn with the same maths as rendering. */
function MaskThumb({ mask }: { mask: Mask }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const image = useEditor((s) => s.image);
  const geometry = useMemo(() => JSON.stringify(mask.components) + mask.invert + mask.amount, [mask]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !image) return;
    const a = image.analysis, span = spanOf(image.bitmap.width, image.bitmap.height), L = Math.max(image.bitmap.width, image.bitmap.height);
    const sample = (mx: number, my: number): [number, number, number] => {
      const x = Math.min(a.width - 1, Math.max(0, Math.round(((mx * L) / image.bitmap.width + 0.5) * a.width - 0.5))), y = Math.min(a.height - 1, Math.max(0, Math.round(((my * L) / image.bitmap.height + 0.5) * a.height - 0.5))), i = (y * a.width + x) * 4;
      return [srgbToLinear(a.data[i] / 255), srgbToLinear(a.data[i + 1] / 255), srgbToLinear(a.data[i + 2] / 255)];
    };
    const w = 48, h = Math.max(12, Math.round((48 * span.hh) / span.hw));
    const g = maskPreview(mask, span, sample, w, h);
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!, img = ctx.createImageData(w, h);
    for (let i = 0; i < g.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g[i]; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }, [geometry, image]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="mask-thumb" aria-hidden />;
}

function AddMenu({ op, maskId }: { op: MaskOp; maskId: string }) {
  const o = OPS.find((x) => x.op === op)!;
  return (
    <Menu label={<><span className="ic">{o.icon}</span> {o.label}</>} className="tool add-btn" testId={`menu-${op}`} ariaLabel={`${o.label} to mask`}>
      {SHAPES.map((t) => <MenuItem key={t} data-add={`${op}:${t}`} onClick={() => { store.selectMask(maskId); store.addComponent(t, op); }}>{SHAPE_NAME[t]}</MenuItem>)}
    </Menu>
  );
}

function ComponentRow({ mask, comp, index }: { mask: Mask; comp: MaskComponent; index: number }) {
  const selected = useEditor((s) => s.selectedComp === comp.id);
  return (
    <div className={`comp-row${selected ? ' selected' : ''}`} data-comp={comp.shape.type}>
      <span className="comp-arrow" aria-hidden>{index === 0 ? '↳' : OP_ICON[comp.op] || '＋'}</span>
      <button className="comp-name" onClick={() => store.selectComp(mask.id, comp.id)}>{SHAPE_NAME[comp.shape.type]}{comp.invert ? ' (inverted)' : ''}{index > 0 && comp.op !== 'add' ? ` · ${comp.op}` : ''}</button>
      <Menu label="⋯" className="icon" ariaLabel="Component options" align="right">
        {OPS.map((o) => <MenuItem key={o.op} data-comp-op={o.op} disabled={comp.op === o.op} onClick={() => store.setComponentMeta(mask.id, comp.id, { op: o.op }, 'Change Mask Operation')}>Combine by {o.label.toLowerCase()}{comp.op === o.op ? ' ✓' : ''}</MenuItem>)}
        <MenuSeparator />
        <MenuItem data-comp-invert="1" onClick={() => store.setComponentMeta(mask.id, comp.id, { invert: !comp.invert }, 'Invert Mask Component')}>{comp.invert ? '✓ ' : ''}Invert this shape</MenuItem>
        <MenuItem aria-label="Delete component" onClick={() => store.removeComponent(mask.id, comp.id)}>Delete this shape</MenuItem>
      </Menu>
    </div>
  );
}

function MaskRow({ mask }: { mask: Mask }) {
  const selected = useEditor((s) => s.selectedMask === mask.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(mask.name);
  return (
    <li className={`mask-row${selected ? ' selected' : ''}${mask.enabled ? '' : ' off'}`} data-mask={mask.id}>
      <div className="mask-head">
        <button className="mask-thumb-btn" aria-label={`Select ${mask.name}`} onClick={() => store.selectMask(mask.id)}><MaskThumb mask={mask} /></button>
        {renaming ? (
          <input className="text" autoFocus aria-label="Mask name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { setRenaming(false); if (name.trim() && name !== mask.name) store.updateMaskMeta(mask.id, { name }, 'Rename Mask'); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(mask.name); setRenaming(false); } e.stopPropagation(); }} />
        ) : (
          <button className="mask-name" onClick={() => store.selectMask(mask.id)} onDoubleClick={() => { setName(mask.name); setRenaming(true); }} title="Double-click to rename">{mask.name}</button>
        )}
        <button className="icon" aria-label={mask.enabled ? 'Hide mask' : 'Show mask'} title={mask.enabled ? 'Disable mask' : 'Enable mask'} onClick={() => store.updateMaskMeta(mask.id, { enabled: !mask.enabled }, mask.enabled ? 'Disable Mask' : 'Enable Mask')}>{mask.enabled ? '👁' : '◌'}</button>
        <Menu label="⋯" className="icon" ariaLabel="Mask options" align="right" testId={selected ? 'mask-options' : undefined}>
          <MenuItem data-mask-invert="1" onClick={() => store.updateMaskMeta(mask.id, { invert: !mask.invert }, 'Invert Mask')}>{mask.invert ? '✓ ' : ''}Invert mask</MenuItem>
          <MenuItem aria-label="Duplicate mask" onClick={() => store.duplicateMask(mask.id)}>Duplicate mask</MenuItem>
          <MenuItem onClick={() => { setName(mask.name); setRenaming(true); }}>Rename…</MenuItem>
          <MenuItem disabled={Object.keys(mask.adjust).length === 0} onClick={() => store.resetMaskAdjust(mask.id)}>Reset adjustments</MenuItem>
          <MenuSeparator />
          <MenuItem aria-label="Delete mask" onClick={() => store.removeMask(mask.id)}>Delete mask</MenuItem>
        </Menu>
      </div>
      {selected && (
        <div className="comp-block">
          {mask.components.map((c, i) => <ComponentRow key={c.id} mask={mask} comp={c} index={i} />)}
          <div className="comp-actions"><AddMenu op="add" maskId={mask.id} /><AddMenu op="subtract" maskId={mask.id} /><AddMenu op="intersect" maskId={mask.id} /></div>
        </div>
      )}
    </li>
  );
}

function MaskDetails({ mask }: { mask: Mask }) {
  const comp = useEditor((s) => mask.components.find((c) => c.id === s.selectedComp) ?? mask.components[0]);
  return (
    <>
      <Panel title="Mask strength">
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
    </>
  );
}

/** The Masking tool: Create New Mask, the list of masks (with thumbnails and their shapes), Show Overlay, then the selected mask's settings. */
export function MaskPanel() {
  const masks = useEditor((s) => s.params.masks);
  const selected = useEditor((s) => s.selectedMask);
  const overlay = useEditor((s) => s.maskOverlay);
  const mask = masks.find((m) => m.id === selected);
  const haveProvider = listSegmentationProviders().length > 0;
  const ai: { kind: 'subject' | 'sky' | 'background'; label: string }[] = [{ kind: 'subject', label: 'Select Subject' }, { kind: 'sky', label: 'Select Sky' }, { kind: 'background', label: 'Select Background' }];
  const off = (id: string, label: string, why: string) => <MenuItem key={id} data-create={id} disabled title={why}>{label}</MenuItem>;
  return (
    <>
      <Panel title={`Masks (${masks.length}/${MAX_MASKS})`}>
        <Menu label={<><span className="plus-circle">＋</span><span>Create New Mask</span></>} className="create-mask" testId="create-mask" ariaLabel="Create new mask">
          {ai.map((a) => <MenuItem key={a.kind} data-create={a.kind} disabled={!haveProvider} title={haveProvider ? undefined : 'Unavailable: no segmentation model is installed'} onClick={() => store.createSegmentMask(a.kind)}>{a.label}</MenuItem>)}
          {off('objects', 'Objects', 'Needs a segmentation model (none is installed)')}
          <MenuSeparator />
          <MenuItem data-create="brush" hint="B" onClick={() => store.createMask('brush')}>Brush</MenuItem>
          <MenuItem data-create="linear" hint="L" onClick={() => store.createMask('linear')}>Linear Gradient</MenuItem>
          <MenuItem data-create="radial" hint="R" onClick={() => store.createMask('radial')}>Radial Gradient</MenuItem>
          <MenuSeparator />
          <MenuItem data-create="color" onClick={() => store.createMask('color')}>Color Range</MenuItem>
          <MenuItem data-create="luminance" onClick={() => store.createMask('luminance')}>Luminance Range</MenuItem>
          {off('depth', 'Depth Range', 'Needs depth information (none is available for JPEG/PNG/WebP files)')}
        </Menu>
        {masks.length === 0 && <p className="note">No masks yet. Create one, then adjust only that area.</p>}
        <ul className="mask-list">{masks.map((m) => <MaskRow key={m.id} mask={m} />)}</ul>
        <div className="overlay-row">
          <label className="switch" title="Show the selected mask as a red overlay (O). It is hidden while you drag a slider.">
            <input type="checkbox" role="switch" aria-label="Show overlay" checked={overlay} onChange={store.toggleMaskOverlay} /><span className="knob" /> <span className="muted">Show Overlay</span>
          </label>
        </div>
        {!haveProvider && <p className="note" data-testid="ai-unavailable">Subject, Sky and Background selection need a segmentation model. None is installed in this build, so they are unavailable rather than faked.</p>}
      </Panel>
      {mask ? <MaskDetails key={mask.id} mask={mask} /> : masks.length > 0 && <p className="note pad">Select a mask to edit it.</p>}
    </>
  );
}
