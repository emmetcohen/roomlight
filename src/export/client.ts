/**
 * Runs exports off the main thread when it can (module Web Worker + OffscreenCanvas + WebGL2),
 * and on the main thread when it cannot (no worker support, blocked worker, no WebGL in
 * workers, masks from an in-memory segmentation provider). Either way the result is the same
 * code path (renderExport); the result says where it ran.
 */
import ExportWorker from './export.worker?worker&inline';
import type { WorkerIn, WorkerOut } from './export.worker';
import { renderExport, type ExportJob, type ExportResult, type ExportStage } from './renderExport';
import { zipStore } from './zip';

export interface RanExport extends ExportResult { ranIn: 'worker' | 'main' }

let worker: Worker | null = null;
let workerUsable = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
let seq = 0;

function viaWorker(job: ExportJob, onStage: (s: ExportStage) => void): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    worker ??= new ExportWorker();
    const w = worker, id = ++seq;
    const cleanup = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
    const onMsg = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.id !== id) return;
      if ('stage' in m) return onStage(m.stage);
      cleanup();
      if ('error' in m) reject(new Error(m.error)); else resolve(m.result);
    };
    const onErr = (e: ErrorEvent) => { cleanup(); worker?.terminate(); worker = null; reject(new Error(e.message || 'The export worker failed to start.')); };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, job } satisfies WorkerIn);
  });
}

export async function runExport(job: ExportJob, onStage: (s: ExportStage) => void = () => undefined, opts: { forceMain?: boolean } = {}): Promise<RanExport> {
  const needsMain = job.params.masks.some((m) => m.components.some((c) => c.shape.type === 'segment')); // provider rasters only exist in this thread
  if (workerUsable && !needsMain && !opts.forceMain) {
    try { return { ...(await viaWorker(job, onStage)), ranIn: 'worker' }; }
    catch { workerUsable = false; /* fall back below; a genuine error (corrupt file...) will be raised by the main-thread run */ }
  }
  return { ...(await renderExport(job, onStage)), ranIn: 'main' };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export { zipStore };
