import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, present, redo, undo, jumpTo, COALESCE_WINDOW_MS } from '../src/history/history';
import { commitParam, previewParam, resetAll, resetParam, resetSection, setParams } from '../src/history/editActions';
import { DEFAULT_PARAMS, paramsEqual } from '../src/image-engine/params';
import { renderImageData } from '../src/image-engine/pipeline';

const fresh = () => createHistory({ ...DEFAULT_PARAMS });

describe('history', () => {
  it('undo restores the previous parameter state and redo restores the later one', () => {
    let h = fresh();
    h = setParams(h, { exposure: 1 }, 'a');
    h = setParams(h, { contrast: 30 }, 'b');
    expect(present(h).contrast).toBe(30);
    h = undo(h);
    expect(present(h).contrast).toBe(0);
    expect(present(h).exposure).toBe(1);
    h = undo(h);
    expect(paramsEqual(present(h), DEFAULT_PARAMS)).toBe(true);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(present(h).exposure).toBe(1);
    h = redo(h);
    expect(present(h).contrast).toBe(30);
    expect(canRedo(h)).toBe(false);
  });

  it('a new edit after undo discards the redo branch', () => {
    let h = fresh();
    h = setParams(h, { exposure: 1 }, 'a');
    h = undo(h);
    h = setParams(h, { shadows: 20 }, 'b');
    expect(canRedo(h)).toBe(false);
    expect(h.entries.length).toBe(2);
  });

  it('a slider drag records exactly one history entry', () => {
    let h = fresh();
    for (let v = 0.1; v <= 1.5; v += 0.1) h = previewParam(h, 'exposure', v);
    expect(h.entries.length).toBe(1); // nothing recorded mid-drag
    expect(present(h).exposure).toBeCloseTo(1.5, 0);
    h = commitParam(h, 'exposure');
    expect(h.entries.length).toBe(2);
    h = undo(h);
    expect(present(h).exposure).toBe(0);
  });

  it('undo during an uncommitted drag discards the drag', () => {
    let h = previewParam(fresh(), 'exposure', 2);
    h = undo(h);
    expect(present(h).exposure).toBe(0);
    expect(h.entries.length).toBe(1);
  });

  it('committing an unchanged value records nothing', () => {
    let h = previewParam(fresh(), 'exposure', 1);
    h = previewParam(h, 'exposure', 0);
    h = commitParam(h, 'exposure');
    expect(h.entries.length).toBe(1);
  });

  it('rapid keyboard nudges coalesce into one entry', () => {
    let h = fresh();
    const t = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      h = previewParam(h, 'contrast', i);
      h = { ...h, ...(() => { const r = commitKey(h, t + i * 50); return r; })() };
    }
    expect(h.entries.length).toBe(2);
    expect(present(h).contrast).toBe(5);
    // after the window a new nudge is a new entry
    h = previewParam(h, 'contrast', 6);
    h = commitKey(h, t + 250 + COALESCE_WINDOW_MS + 10);
    expect(h.entries.length).toBe(3);
  });

  it('reset param / section / all return to defaults and are undoable', () => {
    let h = fresh();
    h = setParams(h, { exposure: 1, contrast: 20, saturation: 30, temperature: 10 }, 'edit');
    h = resetParam(h, 'exposure');
    expect(present(h).exposure).toBe(0);
    expect(present(h).contrast).toBe(20);
    h = resetSection(h, 'tone');
    expect(present(h).contrast).toBe(0);
    expect(present(h).saturation).toBe(30);
    h = resetAll(h);
    expect(paramsEqual(present(h), DEFAULT_PARAMS)).toBe(true);
    h = undo(h);
    expect(present(h).saturation).toBe(30);
  });

  it('reset returns the exact original rendering', () => {
    const src = new Uint8ClampedArray([10, 200, 90, 255, 250, 30, 140, 255, 0, 0, 0, 255]);
    let h = fresh();
    h = setParams(h, { exposure: 2, contrast: 60, temperature: 40, saturation: 50, blacks: 40 }, 'edit');
    expect(Array.from(renderImageData(src, present(h)))).not.toEqual(Array.from(src));
    h = resetAll(h);
    expect(Array.from(renderImageData(src, present(h)))).toEqual(Array.from(src));
  });

  it('jumpTo moves to any snapshot', () => {
    let h = fresh();
    h = setParams(h, { exposure: 1 }, 'a');
    h = setParams(h, { exposure: 2 }, 'b');
    h = jumpTo(h, 1);
    expect(present(h).exposure).toBe(1);
    expect(canRedo(h)).toBe(true);
  });

  it('snapshots are small parameter objects, not images', () => {
    let h = fresh();
    for (let i = 1; i <= 200; i++) h = setParams(h, { exposure: i / 100 }, 'x');
    expect(JSON.stringify(h.entries).length).toBeLessThan(200 * 600);
  });
});

import { commit } from '../src/history/history';
function commitKey(h: ReturnType<typeof fresh>, now: number) {
  return commit(h, 'Adjust Contrast', paramsEqual, { key: 'param:contrast', now });
}
