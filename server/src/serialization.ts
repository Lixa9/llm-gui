import { Worker } from 'node:worker_threads';

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
const waiting = new Set<() => void>();

function releaseWaiting(): void {
  for (const resolve of waiting) resolve();
  waiting.clear();
}

function isLarge(value: unknown, remaining = 64 * 1024): number {
  if (typeof value === 'string') return remaining - value.length;
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      remaining = isLarge(entry, remaining - 16);
      if (remaining <= 0) break;
    }
  }
  return remaining;
}

export async function serializeJson(value: unknown): Promise<string> {
  if (isLarge(value) > 0) return JSON.stringify(value);
  await new Promise<void>(resolve => setImmediate(resolve));
  while (pending.size >= 2) await new Promise<void>(resolve => waiting.add(resolve));
  if (!worker) {
    const instance = new Worker(new URL('./json-worker.ts', import.meta.url));
    worker = instance;
    instance.on('message', (message: { id: number; result: string; error?: string }) => {
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      releaseWaiting();
      if (message.error) task.reject(new Error(message.error));
      else task.resolve(message.result);
      if (!pending.size) instance.unref();
    });
    const fail = (error: Error) => {
      if (worker !== instance) return;
      worker = null;
      for (const task of pending.values()) task.reject(error);
      pending.clear();
      releaseWaiting();
    };
    instance.on('error', fail);
    instance.on('exit', code => fail(new Error(`JSON worker exited (${code})`)));
    instance.unref();
  }
  const instance = worker;
  const id = ++sequence;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    instance.ref();
    try {
      instance.postMessage({ id, value });
    } catch (error) {
      pending.delete(id);
      releaseWaiting();
      if (!pending.size) instance.unref();
      reject(error);
    }
  });
}
