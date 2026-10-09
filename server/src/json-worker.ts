import { parentPort } from 'node:worker_threads';

parentPort!.on('message', ({ id, value }: { id: number; value: unknown }) => {
  try {
    parentPort!.postMessage({ id, result: JSON.stringify(value) });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
