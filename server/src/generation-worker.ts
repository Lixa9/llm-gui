import { randomUUID } from 'node:crypto';
import { getConfig } from './config';
import { getDb, runTransaction, safeParseJson } from './db/index';
import { logger } from './logger';
import { closeStream } from './ratelimit';
import { trackBackgroundTask } from './lifecycle';
import { enqueueTitleJob } from './title-worker';
import type { BackgroundSseClient } from './background-sse';
import type { ChatGenerationRow, ChatGenerationStatus, MessageContentPart, MessageRow } from './types';

interface GenerationSnapshot {
  model: string;
  openai_messages: unknown[];
  history_mode?: 'full' | 'latest_only';
  title_prompt: string;
  is_first_exchange: boolean;
  auto_title: boolean;
  auto_title_model: string;
}

interface RunningControl {
  controller: AbortController;
  reason: 'cancelled' | 'timed_out' | 'idle_timeout' | 'superseded' | 'shutdown' | null;
}

export interface GenerationView {
  id: string;
  conversation_id: string;
  assistant_message_id: string;
  status: ChatGenerationStatus;
  attempt: number;
  last_error: string | null;
  message: ReturnType<typeof serializeMessage> | null;
}

const WORKER_ID = `${process.pid}:${randomUUID()}`;
const LEASE_MS = 10_000;
const HEARTBEAT_MS = 2_000;
const CHECKPOINT_MS = 500;
const SCAN_MS = 1_000;
const activeJobs = new Map<string, RunningControl>();
let scanTimer: NodeJS.Timeout | null = null;
let acceptingWork = true;
let scanBusy = false;

function serializeMessage(row: MessageRow) {
  return { ...row, content: safeParseJson<MessageContentPart[]>(row.content, []) };
}

function contentJson(text: string): string {
  return JSON.stringify(text ? [{ type: 'text', text }] : []);
}

function abortControl(control: RunningControl, reason: RunningControl['reason']): void {
  if (control.controller.signal.aborted) return;
  control.reason = reason;
  control.controller.abort(new DOMException(reason ?? 'Generation aborted', 'AbortError'));
}

async function claimGeneration(id: string): Promise<ChatGenerationRow | undefined> {
  const now = Date.now();
  return runTransaction(async db => {
    const row = await db.prepare(`
      UPDATE chat_generations
      SET status='running', attempt=attempt+1, lease_owner=?, lease_until=?, updated_at=?, last_error=NULL
      WHERE id=? AND available_at<=?
        AND (status='queued' OR (status='running' AND lease_until<?))
      RETURNING *
    `).get<ChatGenerationRow>(WORKER_ID, now + LEASE_MS, now, id, now, now);
    if (!row) return undefined;

    // Every recovered attempt starts from the immutable prompt snapshot. Never
    // append to output left by a worker that disappeared mid-stream.
    await db.prepare("UPDATE messages SET content='[]', content_text='', status='streaming' WHERE id=?").run(row.assistant_message_id);
    if (row.rate_lease_id) {
      await db.prepare(`
        INSERT INTO stream_leases (id, subject, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at
      `).run(row.rate_lease_id, row.owner_sub, now + 30 * 60 * 1000);
    }
    return row;
  });
}

async function checkpoint(row: ChatGenerationRow, fullText: string): Promise<boolean> {
  const result = await getDb().prepare(`
    UPDATE messages m
    SET content=?, content_text=?, status='streaming'
    FROM chat_generations g
    WHERE m.id=g.assistant_message_id AND g.id=? AND g.status='running'
      AND g.lease_owner=? AND g.attempt=?
  `).run(contentJson(fullText), fullText, row.id, WORKER_ID, row.attempt);
  return result.changes > 0;
}

async function finalizeGeneration(
  row: ChatGenerationRow,
  status: Extract<ChatGenerationStatus, 'done' | 'timed_out' | 'failed'>,
  fullText: string,
  error: string | null,
  snapshot?: GenerationSnapshot,
): Promise<MessageRow | undefined> {
  return runTransaction(async db => {
    const current = await db.prepare('SELECT * FROM chat_generations WHERE id=? FOR UPDATE').get<ChatGenerationRow>(row.id);
    if (!current || current.status !== 'running' || current.lease_owner !== WORKER_ID || current.attempt !== row.attempt) return undefined;
    const messageStatus = status;
    await db.prepare('UPDATE messages SET content=?, content_text=?, status=? WHERE id=?')
      .run(contentJson(fullText), fullText, messageStatus, row.assistant_message_id);
    await db.prepare(`
      UPDATE chat_generations
      SET status=?, last_error=?, lease_owner=NULL, lease_until=NULL, request_snapshot='{}'::jsonb,
        updated_at=?, completed_at=?
      WHERE id=?
    `).run(status, error, Date.now(), Date.now(), row.id);
    if (status === 'done' && snapshot?.is_first_exchange && snapshot.auto_title && fullText) {
      await enqueueTitleJob(db, row.id, row.conversation_id, {
        model: snapshot.auto_title_model || snapshot.model,
        title_prompt: snapshot.title_prompt,
        assistant_response: fullText,
      });
    }
    if (row.rate_lease_id) await db.prepare('DELETE FROM stream_leases WHERE id=?').run(row.rate_lease_id);
    return db.prepare('SELECT * FROM messages WHERE id=?').get<MessageRow>(row.assistant_message_id);
  });
}

async function scheduleRetry(row: ChatGenerationRow, error: string): Promise<boolean> {
  const maxAttempts = getConfig().conversation.generation_max_attempts;
  if (row.failure_count + 1 >= maxAttempts) return false;
  const retryAt = Date.now() + Math.min(30_000, 1_000 * (2 ** row.failure_count));
  const result = await getDb().prepare(`
    UPDATE chat_generations
    SET status='queued', available_at=?, lease_owner=NULL, lease_until=NULL,
      failure_count=failure_count+1, last_error=?, updated_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
  `).run(retryAt, error.slice(0, 1000), Date.now(), row.id, WORKER_ID, row.attempt);
  if (result.changes > 0) {
    await getDb().prepare("UPDATE messages SET content='[]', content_text='', status='streaming' WHERE id=?").run(row.assistant_message_id);
  }
  return result.changes > 0;
}

async function generationView(id: string, ownerSub?: string): Promise<GenerationView | null> {
  const params: unknown[] = [id];
  let ownerClause = '';
  if (ownerSub !== undefined) { ownerClause = ' AND g.owner_sub=?'; params.push(ownerSub); }
  const row = await getDb().prepare(`
    SELECT g.*, m.id AS message_id, m.role AS message_role, m.content AS message_content,
      m.content_text AS message_content_text, m.model AS message_model, m.status AS message_status,
      m.timestamp AS message_timestamp, m.edited_at AS message_edited_at
    FROM chat_generations g
    LEFT JOIN messages m ON m.id=g.assistant_message_id
    WHERE g.id=?${ownerClause}
  `).get<ChatGenerationRow & {
    message_id: string | null; message_role: string | null; message_content: string | null;
    message_content_text: string | null; message_model: string | null; message_status: MessageRow['status'];
    message_timestamp: number | null; message_edited_at: number | null;
  }>(...params);
  if (!row) return null;
  const message = row.message_id ? serializeMessage({
    id: row.message_id,
    conversation_id: row.conversation_id,
    role: row.message_role!,
    content: row.message_content!,
    content_text: row.message_content_text!,
    model: row.message_model,
    status: row.message_status,
    timestamp: row.message_timestamp!,
    edited_at: row.message_edited_at,
  }) : null;
  return { id: row.id, conversation_id: row.conversation_id, assistant_message_id: row.assistant_message_id, status: row.status, attempt: row.attempt, last_error: row.last_error, message };
}

async function executeGeneration(row: ChatGenerationRow, client?: BackgroundSseClient): Promise<void> {
  const snapshot = safeParseJson<GenerationSnapshot>(row.request_snapshot, {} as GenerationSnapshot);
  const cfg = getConfig();
  const control: RunningControl = { controller: new AbortController(), reason: null };
  activeJobs.set(row.id, control);
  let fullText = '';
  let lastCheckpoint = 0;
  let heartbeatBusy = false;
  let idleTimer: NodeJS.Timeout;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer!);
    idleTimer = setTimeout(() => abortControl(control, 'idle_timeout'), cfg.conversation.generation_idle_timeout_ms);
  };
  const totalTimer = setTimeout(() => abortControl(control, 'timed_out'), cfg.conversation.generation_max_duration_ms);
  resetIdleTimer();
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || control.controller.signal.aborted) return;
    heartbeatBusy = true;
    void (async () => {
      try {
        const now = Date.now();
        const result = await getDb().prepare(`
          UPDATE chat_generations SET lease_until=?, updated_at=?
          WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
        `).run(now + LEASE_MS, now, row.id, WORKER_ID, row.attempt);
        if (result.changes === 0) abortControl(control, 'superseded');
        else if (row.rate_lease_id) await getDb().prepare('UPDATE stream_leases SET expires_at=? WHERE id=?').run(now + 30 * 60 * 1000, row.rate_lease_id);
      } catch (error) {
        logger.warn('Generation heartbeat failed', { generation_id: row.id, error: String(error) });
        // Once the lease cannot be renewed, continuing upstream work risks a
        // second replica reclaiming the same attempt. Stop and let fencing plus
        // lease recovery decide the authoritative worker.
        abortControl(control, 'superseded');
      } finally {
        heartbeatBusy = false;
      }
    })();
  }, HEARTBEAT_MS);

  try {
    const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: snapshot.model, messages: snapshot.openai_messages, stream: true, ...(snapshot.history_mode === 'latest_only' ? { session_id: row.conversation_id } : {}) }),
      signal: control.controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`upstream error ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (!response.body) throw new Error('Upstream returned no response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      resetIdleTimer();
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { done = true; break; }
          let delta: string | undefined;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            delta = parsed.choices?.[0]?.delta?.content;
          } catch { continue; /* ignore malformed upstream SSE frames */ }
          if (delta) {
            fullText += delta;
            client?.send({ type: 'delta', content: delta });
            if (Date.now() - lastCheckpoint >= CHECKPOINT_MS) {
              if (!await checkpoint(row, fullText)) abortControl(control, 'superseded');
              lastCheckpoint = Date.now();
            }
          }
        }
        if (done) break;
      }
      if (done) break;
    }
    if (!done) throw new Error('Upstream stream ended before completion');

    const assistant = await finalizeGeneration(row, 'done', fullText, null, snapshot);
    if (assistant) {
      client?.send({ type: 'done', message: serializeMessage(assistant) });
    }
  } catch (error) {
    const view = await generationView(row.id).catch(() => null);
    if (!view && row.rate_lease_id) {
      await closeStream(row.rate_lease_id).catch(() => {});
    }
    if (view?.status === 'cancelled') {
      client?.send({ type: 'cancelled', message: view.message });
    } else if (control.reason === 'superseded' || control.reason === 'shutdown') {
      // Another worker owns the attempt, or shutdown handed it back to the queue.
    } else if (control.reason === 'timed_out' || control.reason === 'idle_timeout') {
      const assistant = await finalizeGeneration(row, 'timed_out', fullText, control.reason === 'idle_timeout' ? 'Upstream stream was idle too long' : 'Generation exceeded its time limit');
      client?.send({ type: 'error', message: control.reason === 'idle_timeout' ? 'Generation timed out waiting for the model' : 'Generation exceeded its time limit', ...(assistant ? { response: serializeMessage(assistant) } : {}) });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      if (await scheduleRetry(row, message)) {
        client?.send({ type: 'error', message: 'The model request failed and will be retried automatically' });
      } else {
        await finalizeGeneration(row, 'failed', fullText, message.slice(0, 1000));
        client?.send({ type: 'error', message: 'Upstream request failed' });
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(idleTimer!);
    clearTimeout(totalTimer);
    activeJobs.delete(row.id);
    logger.info('Generation attempt complete', { generation_id: row.id, conversation_id: row.conversation_id, attempt: row.attempt });
  }
}

export async function runGeneration(id: string, client?: BackgroundSseClient): Promise<boolean> {
  if (!acceptingWork || activeJobs.has(id)) return false;
  const row = await claimGeneration(id);
  if (!row) return false;
  await executeGeneration(row, client);
  return true;
}

async function scanForWork(): Promise<void> {
  if (!acceptingWork || scanBusy) return;
  scanBusy = true;
  try {
    const now = Date.now();
    const rows = await getDb().prepare(`
      SELECT id FROM chat_generations
      WHERE available_at<=? AND (status='queued' OR (status='running' AND lease_until<?))
      ORDER BY created_at LIMIT 20
    `).all<{ id: string }>(now, now);
    for (const row of rows) {
      if (activeJobs.has(row.id)) continue;
      trackBackgroundTask(runGeneration(row.id).catch(error => logger.error('Recovered generation failed', { generation_id: row.id, error: String(error) })));
    }
  } finally {
    scanBusy = false;
  }
}

export function initGenerationWorker(): void {
  if (scanTimer) return;
  acceptingWork = true;
  const scan = () => { void scanForWork().catch(error => logger.error('Generation recovery scan failed', { error: String(error) })); };
  scan();
  scanTimer = setInterval(scan, SCAN_MS);
}

export function beginGenerationShutdown(): void {
  acceptingWork = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

export async function releaseGenerationJobs(): Promise<void> {
  beginGenerationShutdown();
  for (const control of activeJobs.values()) abortControl(control, 'shutdown');
  const now = Date.now();
  await getDb().prepare(`
    UPDATE chat_generations SET status='queued', available_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?
    WHERE status='running' AND lease_owner=?
  `).run(now, now, WORKER_ID);
}

export async function getGeneration(id: string, ownerSub: string): Promise<GenerationView | null> {
  return generationView(id, ownerSub);
}

export async function cancelGeneration(id: string, ownerSub: string): Promise<GenerationView | null> {
  await runTransaction(async db => {
    const row = await db.prepare('SELECT * FROM chat_generations WHERE id=? AND owner_sub=? FOR UPDATE').get<ChatGenerationRow>(id, ownerSub);
    if (!row || !['queued', 'running'].includes(row.status)) return;
    await db.prepare("UPDATE messages SET status='aborted' WHERE id=?").run(row.assistant_message_id);
    await db.prepare(`
      UPDATE chat_generations SET status='cancelled', last_error=NULL, lease_owner=NULL,
        lease_until=NULL, request_snapshot='{}'::jsonb, updated_at=?, completed_at=? WHERE id=?
    `).run(Date.now(), Date.now(), id);
    if (row.rate_lease_id) await db.prepare('DELETE FROM stream_leases WHERE id=?').run(row.rate_lease_id);
  });
  const control = activeJobs.get(id);
  if (control) abortControl(control, 'cancelled');
  return generationView(id, ownerSub);
}

export function isActiveGenerationConflict(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string };
  return value?.code === '23505' && value.constraint === 'idx_chat_generations_one_active_conversation';
}
