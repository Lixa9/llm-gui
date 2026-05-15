import { Hono } from 'hono';
import cron from 'node-cron';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { logger } from './logger';
import type { SessionPayload, AutomationRow, AutomationRunRow, ScheduledDefinition, PipelineDefinition } from './types';

export const automationsRouter = new Hono();
automationsRouter.use('*', requireAuth);

function serializeAutomation(row: AutomationRow) {
  return {
    ...row,
    enabled: row.enabled === 1,
    definition: JSON.parse(row.definition),
  };
}

automationsRouter.get('/', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  // For system automations, replace `enabled` with the user's subscription state (default 0).
  const rows = db.prepare(`
    SELECT
      a.id, a.owner_sub, a.name, a.type, a.definition, a.visible_to, a.created_at, a.deleted_at,
      CASE WHEN a.owner_sub IS NULL
        THEN COALESCE((SELECT enabled FROM user_automation_subscriptions WHERE automation_id=a.id AND user_sub=?), 0)
        ELSE a.enabled
      END as enabled
    FROM automations a
    WHERE a.deleted_at IS NULL AND (
      a.owner_sub = ?
      OR (a.owner_sub IS NULL AND (a.visible_to IS NULL OR EXISTS (SELECT 1 FROM json_each(a.visible_to) WHERE value = ?)))
    )
    ORDER BY a.owner_sub IS NULL DESC, a.name
  `).all(user.sub, user.sub, user.role) as AutomationRow[];
  return c.json(rows.map(serializeAutomation));
});

automationsRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { name: string; type: string; definition: unknown };
  const db = getDb();
  const id = generateId();
  db.prepare('INSERT INTO automations (id, owner_sub, name, type, definition) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.type, JSON.stringify(body.definition));
  const row = db.prepare('SELECT * FROM automations WHERE id=?').get(id) as AutomationRow;
  const auto = serializeAutomation(row);

  if (auto.enabled && auto.type === 'scheduled') {
    scheduleAutomation(auto);
  }

  return c.json(auto, 201);
});

automationsRouter.patch('/:id', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { name?: string; definition?: unknown; enabled?: boolean };
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.prepare('SELECT owner_sub FROM automations WHERE id=?').get(id) as { owner_sub: string } | undefined;
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  if (body.name !== undefined) db.prepare('UPDATE automations SET name=? WHERE id=?').run(body.name, id);
  if (body.definition !== undefined) db.prepare('UPDATE automations SET definition=? WHERE id=?').run(JSON.stringify(body.definition), id);
  if (body.enabled !== undefined) db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(body.enabled ? 1 : 0, id);

  const row = db.prepare('SELECT * FROM automations WHERE id=?').get(id) as AutomationRow;
  const auto = serializeAutomation(row);

  // Re-schedule if needed
  removeSchedule(id);
  if (auto.enabled && auto.type === 'scheduled') {
    scheduleAutomation(auto);
  }

  return c.json(auto);
});

automationsRouter.delete('/:id', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  db.prepare("UPDATE automations SET deleted_at=? WHERE id=? AND owner_sub=?").run(Date.now(), id, user.sub);
  removeSchedule(id);
  return c.body(null, 204);
});

automationsRouter.patch('/:id/subscription', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { enabled: boolean };
  const db = getDb();
  const id = c.req.param('id');

  const exists = db.prepare('SELECT id FROM automations WHERE id=? AND owner_sub IS NULL AND deleted_at IS NULL').get(id);
  if (!exists) return c.json({ error: 'Not found' }, 404);

  db.prepare(`
    INSERT INTO user_automation_subscriptions (user_sub, automation_id, enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(user_sub, automation_id) DO UPDATE SET enabled=excluded.enabled
  `).run(user.sub, id, body.enabled ? 1 : 0);

  return c.json({ enabled: body.enabled });
});

automationsRouter.post('/:id/trigger', async (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  const row = db.prepare(
    "SELECT * FROM automations WHERE id=? AND (owner_sub=? OR owner_sub IS NULL) AND deleted_at IS NULL"
  ).get(id, user.sub) as AutomationRow | undefined;
  if (!row) return c.json({ error: 'Not found' }, 404);

  const auto = serializeAutomation(row);
  const run = await runAutomation(auto, 'manual');
  return c.json(run, 201);
});

automationsRouter.get('/:id/runs', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  const auto = db.prepare('SELECT owner_sub FROM automations WHERE id=?').get(id) as { owner_sub: string } | undefined;
  if (!auto || auto.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  const rows = db.prepare(
    'SELECT * FROM automation_runs WHERE automation_id=? ORDER BY started_at DESC LIMIT 50'
  ).all(id) as AutomationRunRow[];
  return c.json(rows);
});

// Scheduler
const scheduledTasks = new Map<string, cron.ScheduledTask>();

function toCron(interval: number, unit: string): string | null {
  const n = Math.max(1, Math.floor(interval));
  if (unit === 'hours') return `0 */${n} * * *`;
  if (unit === 'days') return `0 0 */${n} * *`;
  if (unit === 'weeks') return `0 0 */${n * 7} * *`;
  return null;
}

function scheduleAutomation(auto: ReturnType<typeof serializeAutomation>) {
  if (auto.type !== 'scheduled') return;
  const def = auto.definition as ScheduledDefinition;
  const expr = toCron(def.interval, def.unit);
  if (!expr || !cron.validate(expr)) return;

  const task = cron.schedule(expr, () => {
    runAutomation(auto, 'scheduled').catch(e => logger.error('Automation run failed', { id: auto.id, error: String(e) }));
  });
  scheduledTasks.set(auto.id, task);
}

function removeSchedule(id: string) {
  const task = scheduledTasks.get(id);
  if (task) { task.stop(); scheduledTasks.delete(id); }
}

export function initScheduler() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM automations WHERE enabled=1 AND deleted_at IS NULL AND type='scheduled'"
  ).all() as AutomationRow[];

  for (const row of rows) {
    scheduleAutomation(serializeAutomation(row));
  }
  logger.info('Automation scheduler initialized', { count: rows.length });
}

function makeConversationTitle(autoName: string): string {
  const now = new Date();
  const dayAbbr = now.toLocaleString('en', { weekday: 'short' });
  const day = now.getDate();
  const monAbbr = now.toLocaleString('en', { month: 'short' });
  const year = now.getFullYear();
  const time = now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  return `${autoName} — ${dayAbbr} ${day} ${monAbbr} ${year}, ${time}`;
}

async function runAutomation(auto: ReturnType<typeof serializeAutomation>, source: 'scheduled' | 'manual'): Promise<AutomationRunRow> {
  const db = getDb();
  const runId = generateId();

  logger.info('automation run started', { automation_id: auto.id, name: auto.name, source });

  if (auto.owner_sub === null) {
    // System automation: no pre-created conversation; fan-out happens in executeAutomationRun
    db.prepare('INSERT INTO automation_runs (id, automation_id, status) VALUES (?, ?, ?)')
      .run(runId, auto.id, 'running');
    executeSystemAutomationRun(auto, runId).catch(e => {
      db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
      logger.error('automation run error', { automation_id: auto.id, run_id: runId, error: String(e) });
    });
  } else {
    // Personal automation: one conversation owned by the automation owner
    const convId = generateId();
    const model = (auto.definition as ScheduledDefinition).model ?? null;
    db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, 0, ?)')
      .run(convId, auto.owner_sub, makeConversationTitle(auto.name), model);
    db.prepare('INSERT INTO automation_runs (id, automation_id, conversation_id, status) VALUES (?, ?, ?, ?)')
      .run(runId, auto.id, convId, 'running');
    executePersonalAutomationRun(auto, convId, runId).catch(e => {
      db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
      logger.error('automation run error', { automation_id: auto.id, run_id: runId, error: String(e) });
    });
  }

  return db.prepare('SELECT * FROM automation_runs WHERE id=?').get(runId) as AutomationRunRow;
}

async function executeSystemAutomationRun(auto: ReturnType<typeof serializeAutomation>, runId: string) {
  const db = getDb();
  const cfg = getConfig();
  const start = Date.now();

  try {
    const def = auto.definition as ScheduledDefinition;
    const subscribers = db.prepare(
      'SELECT user_sub FROM user_automation_subscriptions WHERE automation_id=? AND enabled=1'
    ).all(auto.id) as { user_sub: string }[];

    if (subscribers.length > 0) {
      // One LLM call regardless of subscriber count
      const result = await fetchLiteLLMCompletion(auto.id, def.model, def.system_prompt ?? '', def.user_prompt, cfg.litellm.base_url, cfg.litellm.api_key ?? '');
      const title = makeConversationTitle(auto.name);
      for (const { user_sub } of subscribers) {
        const convId = generateId();
        db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, 0, ?)')
          .run(convId, user_sub, title, def.model ?? null);
        storeConversationResult(convId, def.user_prompt, result.assistantText, def.model, result.usage);
      }
    }

    db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
    logger.info('automation run finished', { automation_id: auto.id, run_id: runId, status: 'done', subscribers: subscribers.length, latency_ms: Date.now() - start });
  } catch (e) {
    db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
    logger.error('automation run finished', { automation_id: auto.id, run_id: runId, status: 'error', error: String(e), latency_ms: Date.now() - start });
  }
}

async function executePersonalAutomationRun(auto: ReturnType<typeof serializeAutomation>, convId: string, runId: string) {
  const db = getDb();
  const cfg = getConfig();
  const start = Date.now();

  try {
    if (auto.type === 'scheduled') {
      const def = auto.definition as ScheduledDefinition;
      const result = await fetchLiteLLMCompletion(auto.id, def.model, def.system_prompt ?? '', def.user_prompt, cfg.litellm.base_url, cfg.litellm.api_key ?? '');
      storeConversationResult(convId, def.user_prompt, result.assistantText, def.model, result.usage);
    } else {
      const def = auto.definition as PipelineDefinition;
      for (const step of def.steps ?? []) {
        const result = await fetchLiteLLMCompletion(auto.id, step.model, step.system_prompt ?? '', step.user_prompt, cfg.litellm.base_url, cfg.litellm.api_key ?? '');
        storeConversationResult(convId, step.user_prompt, result.assistantText, step.model, result.usage);
      }
    }
    db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
    logger.info('automation run finished', { automation_id: auto.id, run_id: runId, status: 'done', latency_ms: Date.now() - start });
  } catch (e) {
    db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
    logger.error('automation run finished', { automation_id: auto.id, run_id: runId, status: 'error', error: String(e), latency_ms: Date.now() - start });
  }
}

function storeConversationResult(
  convId: string,
  userPrompt: string,
  assistantText: string,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
) {
  const db = getDb();
  const userContent = JSON.stringify([{ type: 'text', text: userPrompt }]);
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(generateId(), convId, 'user', userContent, userPrompt, 'done');
  const assistantContent = JSON.stringify([{ type: 'text', text: assistantText }]);
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, model, tokens_in, tokens_out, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(generateId(), convId, 'assistant', assistantContent, assistantText, model, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, 'done');
}

async function fetchLiteLLMCompletion(
  automationId: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ assistantText: string; usage: { prompt_tokens?: number; completion_tokens?: number } | undefined }> {
  const messages: unknown[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userPrompt });

  logger.info('automation llm request', { automation_id: automationId, model });
  const llmStart = Date.now();

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  logger.info('automation llm response', { automation_id: automationId, model, status: res.status, latency_ms: Date.now() - llmStart });

  if (!res.ok) throw new Error(`LiteLLM error: ${res.status}`);

  const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  return {
    assistantText: data.choices[0]?.message?.content ?? '',
    usage: data.usage,
  };
}
