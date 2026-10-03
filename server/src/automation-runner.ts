import { randomUUID } from 'node:crypto';
import { getConfig, runtimeConfigurationIsCurrent, assertProviderIdentity, providerIdentity } from './config.ts';
import { generateId, getDb, runTransaction, safeParseJson, type TxDb } from './db/index.ts';
import { parseScheduledDefinition } from './automation-definition.ts';
import { trackBackgroundTask } from './lifecycle.ts';
import { logger } from './logger.ts';
import { findAllowedModel } from './models.ts';
import type { AutomationRow, AutomationRunRow, Role, ScheduledDefinition } from './types.ts';

import { resolveCurrentRole } from './auth.ts';
import { admittedClaim, assertQueueCapacity, AdmissionError } from './work-admission.ts';
import { boundedJson, isRetryable, UpstreamError } from './upstream.ts';

interface AutomationRunSnapshot {
  provider?: {base_url:string;revision:string};
  name: string;
  owner_sub: string | null;
  definition: ScheduledDefinition;
  recipient_subs: string[];
  visible_roles: Role[];
}

interface RunningAutomationControl {
  controller: AbortController;
  reason: 'superseded' | 'shutdown' | 'timed_out' | null;
}

const WORKER_ID = `${process.pid}:automation:${randomUUID()}`;
const LEASE_MS = 10_000;
const HEARTBEAT_MS = 2_000;
const SCAN_MS = 1_000;
const activeJobs = new Map<string, RunningAutomationControl>();
let scanTimer: NodeJS.Timeout | null = null;
let acceptingWork = true;
let scanBusy = false;

function makeConversationTitle(name: string): string {
  return `${name} — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function abortControl(control: RunningAutomationControl, reason: RunningAutomationControl['reason']): void {
  if (control.controller.signal.aborted) return;
  control.reason = reason;
  control.controller.abort(new DOMException(reason ?? 'Automation aborted', 'AbortError'));
}

async function resolveOwnerRole(ownerSub: string): Promise<Role | null> {
  return resolveCurrentRole(ownerSub, true);
}

async function assertModelAccess(snapshot: AutomationRunSnapshot, ownerRole?: Role): Promise<void> {
  if (snapshot.owner_sub !== null) {
    const role = ownerRole ?? await resolveOwnerRole(snapshot.owner_sub);
    if (!role || !await findAllowedModel(snapshot.definition.model, role)) {
      throw new Error('Automation model is not available for the owner role');
    }
    return;
  }
  for (const role of snapshot.visible_roles) {
    if (!await findAllowedModel(snapshot.definition.model, role)) {
      throw new Error(`Automation model is not available for role: ${role}`);
    }
  }
}

export async function enqueueAutomationRun(
  db: TxDb,
  row: AutomationRow,
  source: 'scheduled' | 'manual',
): Promise<AutomationRunRow> {
  const current = await db.prepare('SELECT * FROM automations WHERE id=? FOR UPDATE').get<AutomationRow>(row.id);
  if (!current || current.deleted_at !== null || !current.enabled) throw new AdmissionError('Automation is disabled or deleted');
  row = current;
  if (await db.prepare("SELECT id FROM automation_runs WHERE automation_id=? AND status IN ('queued','running')").get(row.id)) throw new AdmissionError('This automation already has a run in progress');
  await assertQueueCapacity(db);
  const queued = await db.prepare("SELECT count(*)::int AS count FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE a.owner_sub IS NOT DISTINCT FROM ?::text AND r.status IN ('queued','running')").get<{count:number}>(row.owner_sub);
  if ((queued?.count ?? 0) >= 20) throw new AdmissionError('Automation queue limit reached for this owner');
  const definition = parseScheduledDefinition(row.definition);
  const recipientSubs = row.owner_sub === null
    ? (await db.prepare('SELECT user_sub FROM user_automation_subscriptions WHERE automation_id=? AND enabled=true ORDER BY user_sub').all<{ user_sub: string }>(row.id)).map(item => item.user_sub)
    : [row.owner_sub];
  const snapshot: AutomationRunSnapshot = {
    provider: providerIdentity(),
    name: row.name,
    owner_sub: row.owner_sub,
    definition,
    recipient_subs: recipientSubs,
    visible_roles: safeParseJson<Role[] | null>(row.visible_to, null) ?? ['admin', 'user'],
  };
  const runId = generateId();
  const now = Date.now();
  await db.prepare(`
    INSERT INTO automation_runs
      (id, automation_id, status, source, definition_snapshot, available_at, started_at, updated_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
  `).run(runId, row.id, source, JSON.stringify(snapshot), now, now, now);
  for (const userSub of recipientSubs) {
    await db.prepare(`
      INSERT INTO automation_run_deliveries (run_id, user_sub, status)
      VALUES (?, ?, 'queued') ON CONFLICT(run_id, user_sub) DO NOTHING
    `).run(runId, userSub);
  }
  const run = await db.prepare('SELECT * FROM automation_runs WHERE id=?').get<AutomationRunRow>(runId);
  if (!run) throw new Error(`Could not create ${source} automation run`);
  return run;
}

export async function runAutomation(
  row: AutomationRow,
  source: 'scheduled' | 'manual',
  ownerRole?: Role,
): Promise<AutomationRunRow> {
  const snapshot: AutomationRunSnapshot = {
    provider: providerIdentity(),
    name: row.name,
    owner_sub: row.owner_sub,
    definition: parseScheduledDefinition(row.definition),
    recipient_subs: row.owner_sub ? [row.owner_sub] : [],
    visible_roles: safeParseJson<Role[] | null>(row.visible_to, null) ?? ['admin', 'user'],
  };
  await assertModelAccess(snapshot, ownerRole);
  return runTransaction(db => enqueueAutomationRun(db, row, source));
}

async function claimAutomationRun(id: string): Promise<AutomationRunRow | undefined> {
  const now = Date.now();
  return admittedClaim('automation_runs', id, db => db.prepare(`
    UPDATE automation_runs
    SET status='running', attempt=attempt+1, lease_owner=?, lease_until=?, updated_at=?, error=NULL
    WHERE id=? AND available_at<=?
      AND (status='queued' OR (status='running' AND lease_until<?))
    RETURNING *
  `).get<AutomationRunRow>(WORKER_ID, now + LEASE_MS, now, id, now, now));
}

async function persistResult(row: AutomationRunRow, resultText: string): Promise<boolean> {
  const result = await getDb().prepare(`
    UPDATE automation_runs SET result_text=?, updated_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
  `).run(resultText, Date.now(), row.id, WORKER_ID, row.attempt);
  return result.changes > 0;
}

async function deliverResult(
  row: AutomationRunRow,
  snapshot: AutomationRunSnapshot,
  userSub: string,
  resultText: string,
): Promise<void> {
  await runTransaction(async db => {
    const current = await db.prepare('SELECT * FROM automation_runs WHERE id=? FOR UPDATE').get<AutomationRunRow>(row.id);
    if (!current || current.status !== 'running' || current.lease_owner !== WORKER_ID || current.attempt !== row.attempt) {
      throw new Error('AUTOMATION_SUPERSEDED');
    }
    const delivery = await db.prepare(`
      SELECT status FROM automation_run_deliveries WHERE run_id=? AND user_sub=? FOR UPDATE
    `).get<{ status: string }>(row.id, userSub);
    if (!delivery || delivery.status === 'done' || delivery.status === 'skipped') return;

    const auto = await db.prepare('SELECT * FROM automations WHERE id=? FOR SHARE').get<AutomationRow>(row.automation_id);
    await db.prepare('SELECT sub FROM users WHERE sub=? FOR SHARE').get(userSub);
    const role = await resolveCurrentRole(userSub, true);
    const subscription = auto?.owner_sub === null ? await db.prepare('SELECT enabled FROM user_automation_subscriptions WHERE automation_id=? AND user_sub=? FOR SHARE').get<{enabled:boolean}>(row.automation_id,userSub) : null;
    const roles = safeParseJson<Role[] | null>(auto?.visible_to,null);
    const eligible = auto && auto.deleted_at === null && auto.enabled && role &&
      (auto.owner_sub === userSub || (auto.owner_sub === null && subscription?.enabled && (!roles || roles.includes(role)))) &&
      await findAllowedModel(snapshot.definition.model,role);
    if (!eligible) {
      await db.prepare("UPDATE automation_run_deliveries SET status='skipped', error='Recipient no longer eligible', completed_at=? WHERE run_id=? AND user_sub=?").run(Date.now(),row.id,userSub);
      return;
    }
    const convId = generateId();
    const timestamp = Date.now();
    await db.prepare(`
      INSERT INTO conversations (id, owner_sub, title, title_auto, model_id, custom_system_prompt)
      VALUES (?, ?, ?, false, ?, ?)
    `).run(convId, userSub, makeConversationTitle(snapshot.name), snapshot.definition.model || null, snapshot.definition.system_prompt ?? '');
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp)
      VALUES (?, ?, 'user', ?, ?, 'done', ?)
    `).run(generateId(), convId, JSON.stringify([{ type: 'text', text: snapshot.definition.user_prompt }]), snapshot.definition.user_prompt, timestamp);
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp)
      VALUES (?, ?, 'assistant', ?, ?, ?, 'done', ?)
    `).run(generateId(), convId, JSON.stringify([{ type: 'text', text: resultText }]), resultText, snapshot.definition.model, timestamp + 1);
    await db.prepare(`
      UPDATE automation_run_deliveries
      SET status='done', conversation_id=?, error=NULL, completed_at=?
      WHERE run_id=? AND user_sub=?
    `).run(convId, Date.now(), row.id, userSub);
    if (snapshot.owner_sub === userSub) {
      await db.prepare('UPDATE automation_runs SET conversation_id=? WHERE id=?').run(convId, row.id);
    }
  });
}

async function finishAutomationRun(row: AutomationRunRow): Promise<void> {
  const now = Date.now();
  await getDb().prepare(`
    UPDATE automation_runs
    SET status='done', definition_snapshot='{}'::jsonb, lease_owner=NULL, lease_until=NULL,
      error=NULL, updated_at=?, completed_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
  `).run(now, now, row.id, WORKER_ID, row.attempt);
}

async function retryOrFail(row: AutomationRunRow, error: string, retryable = true): Promise<void> {
  const now = Date.now();
  const maxAttempts = getConfig().conversation.generation_max_attempts;
  if (retryable && row.failure_count + 1 < maxAttempts) {
    const retryAt = now + Math.min(30_000, 1_000 * (2 ** row.failure_count));
    await getDb().prepare(`
      UPDATE automation_runs
      SET status='queued', failure_count=failure_count+1, available_at=?, error=?,
        lease_owner=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(retryAt, error.slice(0, 1000), now, row.id, WORKER_ID, row.attempt);
    return;
  }
  await getDb().prepare(`
    UPDATE automation_runs
    SET status='error', failure_count=failure_count+1, definition_snapshot='{}'::jsonb,
      error=?, lease_owner=NULL, lease_until=NULL, updated_at=?, completed_at=?
    WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
  `).run(error.slice(0, 1000), now, now, row.id, WORKER_ID, row.attempt);
}

async function fetchCompletion(definition: ScheduledDefinition, signal: AbortSignal): Promise<string> {
  const cfg = getConfig();
  const messages: unknown[] = [];
  if (definition.system_prompt) messages.push({ role: 'system', content: definition.system_prompt });
  messages.push({ role: 'user', content: definition.user_prompt });
  const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: definition.model, messages, stream: false }),
    signal,
  });
  const data = await boundedJson(response, cfg.conversation.max_output_bytes) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new UpstreamError('Automation model returned no text');
  return content;
}

async function executeAutomationRun(row: AutomationRunRow): Promise<void> {
  const snapshot = safeParseJson<AutomationRunSnapshot>(row.definition_snapshot, {} as AutomationRunSnapshot);
  const control: RunningAutomationControl = { controller: new AbortController(), reason: null };
  activeJobs.set(row.id, control);
  let heartbeatBusy = false;
  const timeout = setTimeout(() => abortControl(control, 'timed_out'), 120_000);
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || control.controller.signal.aborted) return;
    heartbeatBusy = true;
    void getDb().prepare(`
      UPDATE automation_runs SET lease_until=?, updated_at=?
      WHERE id=? AND status='running' AND lease_owner=? AND attempt=?
    `).run(Date.now() + LEASE_MS, Date.now(), row.id, WORKER_ID, row.attempt)
      .then(result => { if (result.changes === 0) abortControl(control, 'superseded'); })
      .catch(error => {
        logger.warn('Automation heartbeat failed', { automation_run_id: row.id, error: String(error) });
        abortControl(control, 'superseded');
      })
      .finally(() => { heartbeatBusy = false; });
  }, HEARTBEAT_MS);

  try {
    if (!snapshot.name || !snapshot.definition || !Array.isArray(snapshot.recipient_subs) || !Array.isArray(snapshot.visible_roles)) throw new Error('Invalid automation run snapshot');
    assertProviderIdentity(snapshot.provider);
    const currentAuto = await getDb().prepare('SELECT enabled, deleted_at FROM automations WHERE id=?').get<{enabled:boolean;deleted_at:number|null}>(row.automation_id);
    if (!currentAuto || !currentAuto.enabled || currentAuto.deleted_at !== null) throw new UpstreamError('Automation was disabled or deleted');
    if (snapshot.owner_sub !== null) await assertModelAccess(snapshot);
    if (snapshot.recipient_subs.length === 0) {
      await finishAutomationRun(row);
      return;
    }
    const currentRecipients: string[] = [];
    for (const recipient of snapshot.recipient_subs) {
      const role = await resolveCurrentRole(recipient, true);
      const auto = await getDb().prepare('SELECT * FROM automations WHERE id=?').get<AutomationRow>(row.automation_id);
      const roles = safeParseJson<Role[] | null>(auto?.visible_to,null);
      const subscribed = snapshot.owner_sub !== null || await getDb().prepare('SELECT user_sub FROM user_automation_subscriptions WHERE automation_id=? AND user_sub=? AND enabled=true').get(row.automation_id,recipient);
      if (auto?.enabled && auto.deleted_at === null && role && subscribed && (!roles || roles.includes(role)) && await findAllowedModel(snapshot.definition.model,role)) currentRecipients.push(recipient);
      else await getDb().prepare("UPDATE automation_run_deliveries SET status='skipped', error='Recipient no longer eligible', completed_at=? WHERE run_id=? AND user_sub=? AND status='queued'").run(Date.now(),row.id,recipient);
    }
    if (!currentRecipients.length) { await finishAutomationRun(row); return; }
    let resultText = row.result_text;
    if (resultText === null) {
      assertProviderIdentity(snapshot.provider);
      if(!await runtimeConfigurationIsCurrent())throw new UpstreamError('Configuration is updating',true);
      resultText = await fetchCompletion(snapshot.definition, control.controller.signal);
      if (!await persistResult(row, resultText)) {
        abortControl(control, 'superseded');
        return;
      }
    }
    if(!await runtimeConfigurationIsCurrent())throw new UpstreamError('Configuration is updating before delivery',true);
    for (const userSub of currentRecipients) {
      if (control.controller.signal.aborted) break;
      await deliverResult(row, snapshot, userSub, resultText);
    }
    if (!control.controller.signal.aborted) await finishAutomationRun(row);
  } catch (error) {
    if ((error as Error).message === 'AUTOMATION_SUPERSEDED') abortControl(control, 'superseded');
    if (control.reason !== 'shutdown' && control.reason !== 'superseded') {
      const message = control.reason === 'timed_out' ? 'Automation exceeded its time limit' : error instanceof Error ? error.message : String(error);
      await retryOrFail(row, message, isRetryable(error));
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    activeJobs.delete(row.id);
  }
}

export async function runAutomationJob(id: string): Promise<boolean> {
  if (!acceptingWork || activeJobs.has(id) || activeJobs.size >= getConfig().rate_limits.global_workers) return false;
  const row = await claimAutomationRun(id);
  if (!row) return false;
  await executeAutomationRun(row);
  return true;
}

async function scanForAutomationRuns(): Promise<void> {
  if (!acceptingWork || scanBusy) return;
  scanBusy = true;
  try {
    const now = Date.now();
    const rows = await getDb().prepare(`
      SELECT id FROM automation_runs
      WHERE available_at<=? AND (status='queued' OR (status='running' AND lease_until<?))
      ORDER BY started_at LIMIT 20
    `).all<{ id: string }>(now, now);
    for (const row of rows) {
      if (activeJobs.has(row.id)) continue;
      trackBackgroundTask(runAutomationJob(row.id).catch(error => logger.error('Recovered automation failed', { automation_run_id: row.id, error: String(error) })));
    }
  } finally {
    scanBusy = false;
  }
}

export function initAutomationWorker(): void {
  if (scanTimer) return;
  acceptingWork = true;
  const scan = () => { void scanForAutomationRuns().catch(error => logger.error('Automation recovery scan failed', { error: String(error) })); };
  scan();
  scanTimer = setInterval(scan, SCAN_MS);
}

export function beginAutomationShutdown(): void {
  acceptingWork = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

export async function releaseAutomationJobs(): Promise<void> {
  beginAutomationShutdown();
  for (const control of activeJobs.values()) abortControl(control, 'shutdown');
  const now = Date.now();
  await getDb().prepare(`
    UPDATE automation_runs
    SET status='queued', available_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?
    WHERE status='running' AND lease_owner=?
  `).run(now, now, WORKER_ID);
}
