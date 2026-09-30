import { useState } from 'react';
import { MIX_ATTRS, MIX_COLORS, MIX_SWATCH, type MixAttr, type ParamKey } from '../image-engine/params';
import { Slider } from '../ui/Slider';
import { store, useEditor } from './store';

const ATTR_LABEL: Record<MixAttr, string> = { hue: 'Hue', sat: 'Saturation', lum: 'Luminance' };

/** Eight colour bands × (hue, saturation, luminance). Bands overlap smoothly (see docs). */
export function MixerPanel() {
  const [attr, setAttr] = useState<MixAttr>('hue');
  const params = useEditor((s) => s.params);
  const keys = MIX_COLORS.map((c) => `mix_${c}_${attr}` as ParamKey);
  const dirty = (a: MixAttr) => MIX_COLORS.some((c) => params[`mix_${c}_${a}` as ParamKey] !== 0);
  return (
    <div>
      <div className="seg wide" role="tablist" aria-label="Mixer attribute">
        {MIX_ATTRS.map((a) => (
          <button key={a} role="tab" aria-selected={a === attr} className={a === attr ? 'on' : ''} onClick={() => setAttr(a)}>
            {ATTR_LABEL[a]}{dirty(a) && <span className="pip" />}
          </button>
        ))}
      </div>
      <div className="mixer-sliders">
        {MIX_COLORS.map((c) => (
          <div key={c} className="mixer-row">
            <span className="swatch" style={{ background: MIX_SWATCH[c] }} />
            <Slider param={`mix_${c}_${attr}` as ParamKey} />
          </div>
        ))}
      </div>
      <button className="tool" style={{ marginTop: 6 }} disabled={keys.every((k) => params[k] === 0)} onClick={() => store.resetKeys(keys, `Reset Mixer ${ATTR_LABEL[attr]}`)}>
        Reset {ATTR_LABEL[attr]}
      </button>
    </div>
  );
}
