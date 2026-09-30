import { describe, expect, it } from 'vitest';
import { IDENTITY_VIEW, MAX_Z, fitScale, panBy, regionFor, screenToOutput, outputToScreen, zoomAt } from '../src/editor/viewMath';

const NW = 6000, NH = 4000, PW = 1500, PH = 1000;
const zFit = fitScale(NW, NH, PW, PH); // 0.25

describe('view math', () => {
  it('fit scale is the largest scale that still shows the whole picture', () => { expect(zFit).toBeCloseTo(0.25); expect(fitScale(4000, 6000, 1500, 1000)).toBeCloseTo(1000 / 6000); });
  it('at fit scale the window is the whole picture', () => { const r = regionFor(zFit, 0.3, 0.7, NW, NH, PW, PH); expect(r.sx).toBeCloseTo(1); expect(r.ox).toBeCloseTo(0); expect(r.cx).toBeCloseTo(0.5); });
  it('100 % shows window-size / picture-size of each axis', () => { const r = regionFor(1, 0.5, 0.5, NW, NH, PW, PH); expect(r.sx).toBeCloseTo(0.25); expect(r.sy).toBeCloseTo(0.25); expect(r.ox).toBeCloseTo(0.375); });
  it('the window never leaves the picture', () => {
    const r = regionFor(1, -5, 9, NW, NH, PW, PH);
    expect(r.ox).toBeGreaterThanOrEqual(0); expect(r.ox + r.sx).toBeLessThanOrEqual(1 + 1e-9); expect(r.oy + r.sy).toBeLessThanOrEqual(1 + 1e-9); expect(r.cx).toBeCloseTo(r.sx / 2);
  });
  it('a picture smaller than the window is centred', () => { const r = regionFor(1, 0.1, 0.1, 400, 300, PW, PH); expect(r.cx).toBe(0.5); expect(r.cy).toBe(0.5); });

  it('zooming keeps the point under the cursor fixed', () => {
    let cur = { z: null as number | null, cx: 0.5, cy: 0.5 };
    const au = 0.8, av = 0.3;
    const u0 = screenToOutput(IDENTITY_VIEW, au, av);
    cur = zoomAt(cur, 4, au, av, NW, NH, PW, PH, zFit); // fit -> 100 %
    expect(cur.z).toBeCloseTo(1);
    const r1 = regionFor(cur.z!, cur.cx, cur.cy, NW, NH, PW, PH);
    const u1 = screenToOutput(r1, au, av);
    expect(u1[0]).toBeCloseTo(u0[0], 6); expect(u1[1]).toBeCloseTo(u0[1], 6);
    // and again from a zoomed, panned state
    const cur2 = zoomAt(cur, 2, 0.2, 0.6, NW, NH, PW, PH, zFit);
    const r2 = regionFor(cur2.z!, cur2.cx, cur2.cy, NW, NH, PW, PH);
    const a = screenToOutput(r1, 0.2, 0.6), b = screenToOutput(r2, 0.2, 0.6);
    expect(b[0]).toBeCloseTo(a[0], 6); expect(b[1]).toBeCloseTo(a[1], 6);
  });
  it('zooming out to the fit size returns to fit; zoom in stops at the maximum', () => {
    expect(zoomAt({ z: 0.3, cx: 0.4, cy: 0.4 }, 0.5, 0.5, 0.5, NW, NH, PW, PH, zFit).z).toBeNull();
    let c = { z: 1 as number | null, cx: 0.5, cy: 0.5 }; for (let i = 0; i < 10; i++) c = zoomAt(c, 2, 0.5, 0.5, NW, NH, PW, PH, zFit);
    expect(c.z).toBe(MAX_Z);
  });
  it('panning moves the picture with the pointer and clamps at the edges', () => {
    const p = panBy(1, 0.5, 0.5, 300, 0, NW, NH, PW, PH); // drag right by 300 device px -> look further left
    expect(p.cx).toBeCloseTo(0.5 - 300 / 6000);
    const far = panBy(1, 0.5, 0.5, 1e6, 1e6, NW, NH, PW, PH); expect(far.cx).toBeCloseTo(0.125); expect(far.cy).toBeCloseTo(0.125);
  });
  it('screen ↔ output mapping round-trips', () => {
    const r = regionFor(2, 0.4, 0.6, NW, NH, PW, PH); const [u, v] = screenToOutput(r, 0.3, 0.9); const [fx, fy] = outputToScreen(r, u, v);
    expect(fx).toBeCloseTo(0.3); expect(fy).toBeCloseTo(0.9);
  });
});
