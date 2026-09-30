/**
 * Runs the Detail pre-pass for the viewer off the main thread (Web Worker), latest request wins:
 * while one job runs, newer requests replace each other in a single waiting slot, so dragging a
 * slider never builds a backlog. Falls back to the main thread if workers are unavailable.
 */
import DetailWorker from './detail.worker?worker&inline';
import { applyAllDetail } from './detail';
import type { DetailIn, DetailOut } from './detail.worker';
import type { DetailInput } from './detailInput';

interface Job { data: Uint8ClampedArray; w: number; h: number; input: DetailInput; scale: number; resolve: (d: Uint8ClampedArray) => void; reject: (e: Error) => void }

let worker: Worker | null = null;
let workerOk = typeof Worker !== 'undefined';
let running: Job | null = null;
let waiting: Job | null = null;
let seq = 0;

function start(job: Job) {
  running = job;
  const finish = () => { running = null; const next = waiting; waiting = null; if (next) start(next); };
  const fallback = () => {
    setTimeout(() => { try { job.resolve(applyAllDetail(job.data, job.w, job.h, job.input.params, job.input.masks, job.scale)); } catch (e) { job.reject(e as Error); } finish(); }, 0);
  };
  if (!workerOk) return fallback();
  try {
    worker ??= new DetailWorker();
    const w = worker, id = ++seq;
    const onMsg = (e: MessageEvent<DetailOut>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr);
      if ('error' in e.data) job.reject(new Error(e.data.error)); else job.resolve(e.data.data);
      finish();
    };
    const onErr = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); worker?.terminate(); worker = null; workerOk = false; fallback(); };
    w.addEventListener('message', onMsg); w.addEventListener('error', onErr);
    const copy = job.data.slice(); // the worker gets its own copy (transferred), the source stays intact
    w.postMessage({ id, data: copy, w: job.w, h: job.h, input: job.input, scale: job.scale } satisfies DetailIn, [copy.buffer]);
  } catch { workerOk = false; fallback(); }
}

/** Resolves with the processed pixels, or rejects with 'superseded' if a newer request replaced this one while it waited. */
export function runDetail(data: Uint8ClampedArray, w: number, h: number, input: DetailInput, scale: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const job: Job = { data, w, h, input, scale, resolve, reject };
    if (!running) return start(job);
    waiting?.reject(new Error('superseded'));
    waiting = job;
  });
}
