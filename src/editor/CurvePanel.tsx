import { useState } from 'react';
import { Slider } from '../ui/Slider';
import { CurveEditor } from './CurveEditor';

/** Point curve (draw it) or Parametric curve (four region sliders). Both are live at once: the parametric curve is applied first. */
export function CurvePanel() {
  const [mode, setMode] = useState<'point' | 'parametric'>('point');
  return (
    <div>
      <div className="seg wide" role="tablist" aria-label="Curve mode">
        <button role="tab" aria-selected={mode === 'point'} data-curve-mode="point" className={mode === 'point' ? 'on' : ''} onClick={() => setMode('point')}>Point Curve</button>
        <button role="tab" aria-selected={mode === 'parametric'} data-curve-mode="parametric" className={mode === 'parametric' ? 'on' : ''} onClick={() => setMode('parametric')}>Parametric Curve</button>
      </div>
      {mode === 'point' ? <CurveEditor /> : (
        <>
          <Slider param="curveHighlights" /><Slider param="curveLights" /><Slider param="curveDarks" /><Slider param="curveShadows" />
          <p className="note">Each slider raises or lowers one tonal region; black and white stay fixed. The point curve is applied after this.</p>
        </>
      )}
    </div>
  );
}
