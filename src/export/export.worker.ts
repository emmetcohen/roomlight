/// <reference lib="webworker" />
import { renderExport, type ExportJob, type ExportStage } from './renderExport';

export type WorkerIn = { id: number; job: ExportJob };
export type WorkerOut = { id: number; stage: ExportStage } | { id: number; result: Awaited<ReturnType<typeof renderExport>> } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const { id, job } = e.data;
  try {
    const result = await renderExport(job, (stage) => (self as unknown as Worker).postMessage({ id, stage } satisfies WorkerOut));
    (self as unknown as Worker).postMessage({ id, result } satisfies WorkerOut, [result.bytes.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies WorkerOut);
  }
};
