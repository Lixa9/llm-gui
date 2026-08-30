import { randomUUID } from 'node:crypto';
import { getConfig } from './config.ts';
import { generateId, getDb, runTransaction, safeParseJson, type TxDb } from './db/index.ts';
import { trackBackgroundTask } from './lifecycle.ts';
import { logger } from './logger.ts';
import type { ConversationTitleJobRow } from './types.ts';

interface TitleRequestSnapshot {
  model: string;
  title_prompt: string;
  assistant_response: string;
}

interface RunningTitleControl {
  controller: AbortController;
  reason: 'superseded' | 'shutdown' | 'timed_out' | null;
}

const WORKER_ID = `${process.pid}:title:${randomUUID()}`;
const LEASE_MS = 10_000;
const HEARTBEAT_MS = 2_000;
const SCAN_MS = 1_000;
const activeJobs = new Map<string, RunningTitleControl>();
let scanTimer: NodeJS.Timeout | null = null;
let acceptingWork = true;
let scanBusy = false;

function abortControl(control: RunningTitleControl, reason: RunningTitleControl['reason']): void {
  if (control.controller.signal.aborted) return;
  control.reason = reason;
  control.controller.abort(new DOMException(reason ?? 'Title generation aborted', 'AbortError'));
}

export async function enqueueTitleJob(
  db: TxDb,
  generationId: string,
  conversationId: string,
  snapshot: TitleRequestSnapshot,
): Promise<void> {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO conversation_title_jobs
      (id, generation_id, conversation_id, request_snapshot, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    ON CONFLICT(generation_id) DO NOTHING
  `).run(generateId(), generationId, conversationId, JSON.stringify(snapshot), now, now, now);
}

async function claimTitleJob(id: string): Promise<ConversationTitleJobRow | undefined> {
  const now = Date.now();
  return getDb().prepare(`
    UPDATE conversation_title_jobs
    SET status='running', attempt=attempt+1, lease_owner=?, lease_until=?, updated_at=?, last_error=NULL
    WHERE id=? AND available_at<=?
      AND (status='queued' OR (status='running' AND lease_until<?))
    RETURNING *
  `).get<ConversationTitleJobRow>(WORKER_ID, now + LEASE_MS, now, id, now, now);
}

async function finishTitleJob(row: ConversationTitleJobRow, title: string): Promise<boolean> {
  return runTransaction(async db => {
    const current = await db.prepare('SELECT * FROM conversation_title_jobs WHERE id=? FOR UPDATE').get<ConversationTitleJobRow>(row.id);
    if (!current || current.status !== 'running' || current.lease_owner !== WORKER_ID || current.attempt !== row.attempt) return false;
    const result = await db.prepare(`
      UPDATE conversations SET title=?, title_auto=true
      WHERE id=? AND title_auto=false AND title='New conversation'
    `).run(title, row.conversation_id);
    const now = Date.now();
    await db.prepare(`
      UPDATE conversation_title_jobs
      SET status=?, request_snapshot='{}'::jsonb, lease_owner=NULL, lease_until=NULL,
        updated_at=?, completed_at=? WHERE id=?
    `).run(result.changes > 0 ? 'done' : 'skipped', now, now, row.id);
    return true;
  });
}

async function retryOrFail(row: ConversationTitleJobRow, error: string): Promise<void> {
  const now = Date.now();
  const maxAttempts = getConfig().conversation.generation_max_attempts;
  if (row.failure_count + 1 < maxAttempts) {
    const retryAt = now + Math.min(30_000, 1_000 * (2 ** row.failure_count));
    await getDb().prepare(`
      UPDATE conversation_title_jobs
      SET status='queued', failure_count=failure_count+1, available_at=?, last_error=?,
        lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(retryAt, error.slice(0, 1000), now, row.id, WORKER_ID, row.attempt);
    return;
  }
  await getDb().prepare(`
    UPDATE conversation_title_jobs
    SET status='failed', failure_count=failure_count+1, request_snapshot='{}'::jsonb,
      last_error=?, lease_owner=NULL, lease_until=NULL, updated_at=?, completed_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
  `).run(error.slice(0, 1000), now, now, row.id, WORKER_ID, row.attempt);
}

async function executeTitleJob(row: ConversationTitleJobRow): Promise<void> {
  const snapshot = safeParseJson<TitleRequestSnapshot>(row.request_snapshot, {} as TitleRequestSnapshot);
  const control: RunningTitleControl = { controller: new AbortController(), reason: null };
  activeJobs.set(row.id, control);
  let heartbeatBusy = false;
  const timeout = setTimeout(() => abortControl(control, 'timed_out'), 20_000);
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || control.controller.signal.aborted) return;
    heartbeatBusy = true;
    void getDb().prepare(`
      UPDATE conversation_title_jobs SET lease_until=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(Date.now() + LEASE_MS, Date.now(), row.id, WORKER_ID, row.attempt)
      .then(result => { if (result.changes === 0) abortControl(control, 'superseded'); })
      .catch(error => {
        logger.warn('Title job heartbeat failed', { title_job_id: row.id, error: String(error) });
        abortControl(control, 'superseded');
      })
      .finally(() => { heartbeatBusy = false; });
  }, HEARTBEAT_MS);

  try {
    if (!snapshot.model || !snapshot.title_prompt || !snapshot.assistant_response) throw new Error('Invalid title job snapshot');
    const cfg = getConfig();
    const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: snapshot.model,
        stream: false,
        max_tokens: 20,
        messages: [
          { role: 'system', content: 'Return a 4-6 word title for this conversation. No punctuation, no quotes.' },
          { role: 'user', content: `${snapshot.title_prompt}\n\n${snapshot.assistant_response}`.slice(0, 2000) },
        ],
      }),
      signal: control.controller.signal,
    });
    if (!response.ok) throw new Error(`title upstream error ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const title = data.choices?.[0]?.message?.content?.trim().slice(0, 80);
    if (!title) throw new Error('Title upstream returned an empty title');
    await finishTitleJob(row, title);
  } catch (error) {
    if (control.reason !== 'shutdown' && control.reason !== 'superseded') {
      const message = control.reason === 'timed_out' ? 'Title generation timed out' : error instanceof Error ? error.message : String(error);
      await retryOrFail(row, message);
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    activeJobs.delete(row.id);
  }
}

export async function runTitleJob(id: string): Promise<boolean> {
  if (!acceptingWork || activeJobs.has(id)) return false;
  const row = await claimTitleJob(id);
  if (!row) return false;
  await executeTitleJob(row);
  return true;
}

async function scanForTitleJobs(): Promise<void> {
  if (!acceptingWork || scanBusy) return;
  scanBusy = true;
  try {
    const now = Date.now();
    const rows = await getDb().prepare(`
      SELECT id FROM conversation_title_jobs
      WHERE available_at<=? AND (status='queued' OR (status='running' AND lease_until<?))
      ORDER BY created_at LIMIT 20
    `).all<{ id: string }>(now, now);
    for (const row of rows) {
      if (activeJobs.has(row.id)) continue;
      trackBackgroundTask(runTitleJob(row.id).catch(error => logger.error('Recovered title job failed', { title_job_id: row.id, error: String(error) })));
    }
  } finally {
    scanBusy = false;
  }
}

export function initTitleWorker(): void {
  if (scanTimer) return;
  acceptingWork = true;
  const scan = () => { void scanForTitleJobs().catch(error => logger.error('Title recovery scan failed', { error: String(error) })); };
  scan();
  scanTimer = setInterval(scan, SCAN_MS);
}

export function beginTitleShutdown(): void {
  acceptingWork = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

export async function releaseTitleJobs(): Promise<void> {
  beginTitleShutdown();
  for (const control of activeJobs.values()) abortControl(control, 'shutdown');
  const now = Date.now();
  await getDb().prepare(`
    UPDATE conversation_title_jobs
    SET status='queued', available_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?
    WHERE status='running' AND lease_owner=?
  `).run(now, now, WORKER_ID);
}
