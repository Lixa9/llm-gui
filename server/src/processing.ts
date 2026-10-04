import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { getConfig } from './config.ts';

export interface DerivedImage {
  data: string;
  ext: string;
  label?: string;
  frame_count?: number;
}
export interface BlockLocation {
  part?: string;
  entry?: string;
  notices?: string[];
}
export type AttachmentBlock = BlockLocation & (
  | { type: 'text'; text: string; format?: 'csv' | 'jsonl' }
  | { type: 'image'; image_index: number }
);
export interface ProcessedFile {
  text: string | null;
  meta: Record<string, unknown>;
  images: DerivedImage[];
  warning?: string;
  blocks?: AttachmentBlock[];
}
let active = 0;
/** A child process keeps synchronous native/XML/archive work off the HTTP loop. */
export async function processUpload(bytes: Buffer, mime: string, filename: string): Promise<ProcessedFile> {
  if (active >= getConfig().attachments.processing_workers)
    throw new Error('Document processors are busy. Try the upload again shortly.');
  active++;
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'llm-processing-'));
    return await new Promise<ProcessedFile>((resolve, reject) => {
      const child = fork(new URL('./processing-child.ts', import.meta.url), [], {
        execArgv: ['--max-old-space-size=256'],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, TMPDIR: workspace },
        detached: process.platform !== 'win32',
      });
      const kill = () => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      };
      const timer = setTimeout(() => {
        kill();
        reject(new Error('Document processing exceeded its 60 second limit'));
      }, 60_000);
      child.once('message', (message: { result?: ProcessedFile; error?: string }) => {
        clearTimeout(timer);
        kill();
        if (message.result) resolve(message.result);
        else reject(new Error(message.error ?? 'Document processing failed'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        kill();
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Document processor exited (${code})`));
      });
      child.send({ bytes, mime, filename });
    });
  } finally {
    active--;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
