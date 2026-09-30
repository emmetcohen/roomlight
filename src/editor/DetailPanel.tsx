import { SLIDERS } from '../image-engine/params';
import { Slider } from '../ui/Slider';

const of = (keys: string[]) => keys.map((k) => SLIDERS.find((s) => s.key === k)!);

/** Sharpening and noise reduction (see image-engine/detail.ts). They run on the source pixels before every other adjustment. */
export function DetailPanel() {
  return (
    <>
      <div className="subhead" style={{ marginTop: 0 }}>Sharpening</div>
      {of(['sharpAmount', 'sharpRadius', 'sharpDetail', 'sharpMasking']).map((s) => <Slider key={s.key} param={s.key} />)}
      <div className="subhead">Noise Reduction</div>
      {of(['nrLuma', 'nrLumaDetail', 'nrLumaContrast']).map((s) => <Slider key={s.key} param={s.key} />)}
      <div className="subhead">Color</div>
      {of(['nrColor', 'nrColorDetail', 'nrColorSmooth']).map((s) => <Slider key={s.key} param={s.key} />)}
      <p className="note">Radius is measured in pixels of the original photo, so the preview matches the export. Processing runs in the background; the picture updates when it finishes.</p>
    </>
  );
}
