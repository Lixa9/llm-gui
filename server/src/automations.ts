import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { getDb, generateId, safeParseJson } from './db/index';
import { getConfig } from './config';
import { logger } from './logger';
import type { AutomationRow, AutomationRunRow, ScheduledDefinition } from './types';

const automationSchema = z.object({ name: z.string().trim().min(1).max(200), definition: z.record(z.unknown()) });
export const automationsRouter = new Hono();
automationsRouter.use('*', requireAuth);

function serializeAutomation(row: AutomationRow) {
  return { ...row, enabled: Boolean(row.enabled), definition: safeParseJson<Record<string, unknown>>(row.definition, {}) };
}

function visibleTo(row: AutomationRow, role: string): boolean {
  if (row.owner_sub !== null) return true;
  const roles = safeParseJson<string[] | null>(row.visible_to, null);
  return !roles || roles.includes(role);
}

automationsRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await getDb().prepare(`
    SELECT a.id, a.owner_sub, a.name, a.definition, a.visible_to, a.created_at, a.deleted_at,
      CASE WHEN a.owner_sub IS NULL THEN COALESCE((SELECT enabled FROM user_automation_subscriptions WHERE automation_id=a.id AND user_sub=?), false) ELSE a.enabled END AS enabled
    FROM automations a WHERE a.deleted_at IS NULL AND (a.owner_sub=? OR (a.owner_sub IS NULL AND (a.visible_to IS NULL OR a.visible_to @> to_jsonb(?::text))))
    ORDER BY a.owner_sub IS NULL DESC, a.name
  `).all<AutomationRow>(user.sub, user.sub, user.role);
  return c.json(rows.map(serializeAutomation));
});

automationsRouter.post('/', async (c) => {
  const parsed = automationSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid automation' }, 400);
  const user = c.get('user');
  const id = generateId();
  await getDb().prepare('INSERT INTO automations (id, owner_sub, name, type, definition) VALUES (?, ?, ?, ?, ?::jsonb)')
    .run(id, user.sub, parsed.data.name, 'scheduled', JSON.stringify(parsed.data.definition));
  const row = await getDb().prepare('SELECT * FROM automations WHERE id=?').get<AutomationRow>(id);
  if (!row) return c.json({ error: 'Failed to create automation' }, 500);
  return c.json(serializeAutomation(row), 201);
});

automationsRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await getDb().prepare('SELECT owner_sub FROM automations WHERE id=?').get<{ owner_sub: string | null }>(id);
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json() as { name?: unknown; definition?: unknown; enabled?: unknown };
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) return c.json({ error: 'Invalid name' }, 400);
  if (body.definition !== undefined && (!body.definition || typeof body.definition !== 'object' || Array.isArray(body.definition))) return c.json({ error: 'Invalid definition' }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid enabled value' }, 400);
  await getDb().prepare(`
    UPDATE automations SET name=COALESCE(?, name), definition=COALESCE(?::jsonb, definition), enabled=COALESCE(?, enabled)
    WHERE id=? AND owner_sub=?
  `).run(typeof body.name === 'string' ? body.name.trim() : undefined, body.definition === undefined ? undefined : JSON.stringify(body.definition), body.enabled, id, user.sub);
  const row = await getDb().prepare('SELECT * FROM automations WHERE id=?').get<AutomationRow>(id);
  return row ? c.json(serializeAutomation(row)) : c.json({ error: 'Not found' }, 404);
});

automationsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  await getDb().prepare('UPDATE automations SET deleted_at=?, enabled=false WHERE id=? AND owner_sub=?').run(Date.now(), c.req.param('id'), user.sub);
  return c.body(null, 204);
});

automationsRouter.patch('/:id/subscription', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
  if (!await getDb().prepare('SELECT id FROM automations WHERE id=? AND owner_sub IS NULL AND deleted_at IS NULL AND (visible_to IS NULL OR visible_to @> to_jsonb(?::text))').get(c.req.param('id'), user.role)) return c.json({ error: 'Not found' }, 404);
  await getDb().prepare(`INSERT INTO user_automation_subscriptions (user_sub, automation_id, enabled) VALUES (?, ?, ?)
    ON CONFLICT(user_sub, automation_id) DO UPDATE SET enabled=excluded.enabled`).run(user.sub, c.req.param('id'), body.enabled);
  return c.json({ enabled: body.enabled });
});

automationsRouter.post('/:id/trigger', async (c) => {
  const user = c.get('user');
  const row = await getDb().prepare('SELECT * FROM automations WHERE id=? AND deleted_at IS NULL AND (owner_sub=? OR owner_sub IS NULL)').get<AutomationRow>(c.req.param('id'), user.sub);
  if (!row || !visibleTo(row, user.role)) return c.json({ error: 'Not found' }, 404);
  return c.json(await runAutomation(row, 'manual'), 201);
});

automationsRouter.get('/:id/runs', async (c) => {
  const user = c.get('user');
  const auto = await getDb().prepare('SELECT owner_sub FROM automations WHERE id=?').get<{ owner_sub: string | null }>(c.req.param('id'));
  if (!auto || auto.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);
  return c.json(await getDb().prepare('SELECT * FROM automation_runs WHERE automation_id=? ORDER BY started_at DESC LIMIT 50').all<AutomationRunRow>(c.req.param('id')));
});

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

function intervalMs(def: ScheduledDefinition): number {
  const n = Math.max(1, Math.floor(def.interval || 1));
  if (def.unit === 'hours') return n * 3_600_000;
  if (def.unit === 'weeks') return n * 7 * 86_400_000;
  return n * 86_400_000;
}

async function claimDueAutomation(): Promise<AutomationRow | null> {
  const now = Date.now();
  return getDb().transaction(async db => {
    const row = await db.prepare('SELECT * FROM automations WHERE enabled=true AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED').get<AutomationRow>(now);
    if (!row) return null;
    const def = safeParseJson<ScheduledDefinition>(row.definition, { interval: 1, unit: 'days', model: '', user_prompt: '' });
    await db.prepare('UPDATE automations SET next_run_at=? WHERE id=?').run(now + intervalMs(def), row.id);
    return row;
  });
}

async function schedulerTick(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const row = await claimDueAutomation();
    if (row) await runAutomation(row, 'scheduled');
  } catch (error) { logger.error('Automation scheduler tick failed', { error: String(error) }); }
  finally { schedulerRunning = false; }
}

export async function initScheduler(): Promise<void> {
  const rows = await getDb().prepare('SELECT id, definition FROM automations WHERE enabled=true AND deleted_at IS NULL AND next_run_at IS NULL').all<{ id: string; definition: unknown }>();
  for (const row of rows) {
    const def = safeParseJson<ScheduledDefinition>(row.definition, { interval: 1, unit: 'days', model: '', user_prompt: '' });
    await getDb().prepare('UPDATE automations SET next_run_at=? WHERE id=? AND next_run_at IS NULL').run(Date.now() + intervalMs(def), row.id);
  }
  schedulerTimer = setInterval(() => { void schedulerTick(); }, 30_000);
  schedulerTimer.unref();
  logger.info('Automation scheduler initialized', { count: rows.length });
}

export function stopScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

function makeConversationTitle(name: string): string {
  return `${name} — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

async function runAutomation(row: AutomationRow, source: 'scheduled' | 'manual'): Promise<AutomationRunRow> {
  const db = getDb();
  const runId = generateId();
  if (row.owner_sub === null) {
    await db.prepare('INSERT INTO automation_runs (id, automation_id, status) VALUES (?, ?, ?)').run(runId, row.id, 'running');
    void executeSystemAutomationRun(row, runId).catch(error => logger.error('System automation failed', { error: String(error) }));
  } else {
    const def = safeParseJson<ScheduledDefinition>(row.definition, { interval: 1, unit: 'days', model: '', user_prompt: '' });
    const convId = generateId();
    await db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, false, ?)').run(convId, row.owner_sub, makeConversationTitle(row.name), def.model ?? null);
    await db.prepare('INSERT INTO automation_runs (id, automation_id, conversation_id, status) VALUES (?, ?, ?, ?)').run(runId, row.id, convId, 'running');
    void executePersonalAutomationRun(row, convId, runId).catch(error => logger.error('Personal automation failed', { error: String(error) }));
  }
  const run = await db.prepare('SELECT * FROM automation_runs WHERE id=?').get<AutomationRunRow>(runId);
  if (!run) throw new Error(`Could not create ${source} automation run`);
  return run;
}

async function executeSystemAutomationRun(row: AutomationRow, runId: string): Promise<void> {
  const db = getDb();
  try {
    const def = safeParseJson<ScheduledDefinition>(row.definition, { interval: 1, unit: 'days', model: '', user_prompt: '' });
    const subscribers = await db.prepare('SELECT user_sub FROM user_automation_subscriptions WHERE automation_id=? AND enabled=true').all<{ user_sub: string }>(row.id);
    if (subscribers.length) {
      const result = await fetchCompletion(def);
      for (const subscriber of subscribers) {
        const convId = generateId();
        await db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, false, ?)').run(convId, subscriber.user_sub, makeConversationTitle(row.name), def.model ?? null);
        await storeConversationResult(convId, def.user_prompt, result.assistantText, def.model, result.usage);
      }
    }
    await db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
  } catch (error) {
    await db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(error), runId);
  }
}

async function executePersonalAutomationRun(row: AutomationRow, convId: string, runId: string): Promise<void> {
  const db = getDb();
  try {
    const def = safeParseJson<ScheduledDefinition>(row.definition, { interval: 1, unit: 'days', model: '', user_prompt: '' });
    const result = await fetchCompletion(def);
    await storeConversationResult(convId, def.user_prompt, result.assistantText, def.model, result.usage);
    await db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
  } catch (error) {
    await db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(error), runId);
  }
}

async function storeConversationResult(convId: string, userPrompt: string, assistantText: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): Promise<void> {
  const db = getDb();
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, status) VALUES (?, ?, ?, ?, ?, ?)').run(generateId(), convId, 'user', JSON.stringify([{ type: 'text', text: userPrompt }]), userPrompt, 'done');
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, model, tokens_in, tokens_out, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(generateId(), convId, 'assistant', JSON.stringify([{ type: 'text', text: assistantText }]), assistantText, model, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, 'done');
}

async function fetchCompletion(def: ScheduledDefinition): Promise<{ assistantText: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const cfg = getConfig();
  const messages: unknown[] = [];
  if (def.system_prompt) messages.push({ role: 'system', content: def.system_prompt });
  messages.push({ role: 'user', content: def.user_prompt });
  const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: def.model, messages, stream: false }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`upstream error: ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { assistantText: data.choices?.[0]?.message?.content ?? '', usage: data.usage };
}
