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
  const rows = db.query<AutomationRow, [string]>(
    "SELECT * FROM automations WHERE owner_sub=? AND deleted_at IS NULL ORDER BY name"
  ).all(user.sub);
  return c.json(rows.map(serializeAutomation));
});

automationsRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { name: string; type: string; definition: unknown };
  const db = getDb();
  const id = generateId();
  db.query('INSERT INTO automations (id, owner_sub, name, type, definition) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.type, JSON.stringify(body.definition));
  const row = db.query<AutomationRow, [string]>('SELECT * FROM automations WHERE id=?').get(id)!;
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

  const existing = db.query<{ owner_sub: string }, [string]>('SELECT owner_sub FROM automations WHERE id=?').get(id);
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  if (body.name !== undefined) db.query('UPDATE automations SET name=? WHERE id=?').run(body.name, id);
  if (body.definition !== undefined) db.query('UPDATE automations SET definition=? WHERE id=?').run(JSON.stringify(body.definition), id);
  if (body.enabled !== undefined) db.query('UPDATE automations SET enabled=? WHERE id=?').run(body.enabled ? 1 : 0, id);

  const row = db.query<AutomationRow, [string]>('SELECT * FROM automations WHERE id=?').get(id)!;
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
  db.query("UPDATE automations SET deleted_at=? WHERE id=? AND owner_sub=?").run(Date.now(), id, user.sub);
  removeSchedule(id);
  return c.body(null, 204);
});

automationsRouter.post('/:id/trigger', async (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  const row = db.query<AutomationRow, [string, string]>(
    "SELECT * FROM automations WHERE id=? AND owner_sub=?"
  ).get(id, user.sub);
  if (!row) return c.json({ error: 'Not found' }, 404);

  const auto = serializeAutomation(row);
  const run = await runAutomation(auto);
  return c.json(run, 201);
});

automationsRouter.get('/:id/runs', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  const auto = db.query<{ owner_sub: string }, [string]>('SELECT owner_sub FROM automations WHERE id=?').get(id);
  if (!auto || auto.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  const rows = db.query<AutomationRunRow, [string]>(
    'SELECT * FROM automation_runs WHERE automation_id=? ORDER BY started_at DESC LIMIT 50'
  ).all(id);
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
    runAutomation(auto).catch(e => logger.error('Automation run failed', { id: auto.id, error: String(e) }));
  });
  scheduledTasks.set(auto.id, task);
}

function removeSchedule(id: string) {
  const task = scheduledTasks.get(id);
  if (task) { task.stop(); scheduledTasks.delete(id); }
}

export function initScheduler() {
  const db = getDb();
  const rows = db.query<AutomationRow, []>(
    "SELECT * FROM automations WHERE enabled=1 AND deleted_at IS NULL AND type='scheduled'"
  ).all();

  for (const row of rows) {
    scheduleAutomation(serializeAutomation(row));
  }
  logger.info('Automation scheduler initialized', { count: rows.length });
}

async function runAutomation(auto: ReturnType<typeof serializeAutomation>): Promise<AutomationRunRow> {
  const db = getDb();
  const cfg = getConfig();
  const runId = generateId();

  // Create a conversation for this run
  const now = new Date();
  const dayAbbr = now.toLocaleString('en', { weekday: 'short' });
  const day = now.getDate();
  const monAbbr = now.toLocaleString('en', { month: 'short' });
  const year = now.getFullYear();
  const time = now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  const title = `${auto.name} — ${dayAbbr} ${day} ${monAbbr} ${year}, ${time}`;

  const convId = generateId();
  db.query('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, 0, ?)')
    .run(convId, auto.owner_sub ?? 'system', title, (auto.definition as ScheduledDefinition).model ?? null);

  db.query('INSERT INTO automation_runs (id, automation_id, conversation_id, status) VALUES (?, ?, ?, ?)')
    .run(runId, auto.id, convId, 'running');

  // Execute asynchronously
  executeAutomationRun(auto, convId, runId).catch(e => {
    db.query('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
  });

  return db.query<AutomationRunRow, [string]>('SELECT * FROM automation_runs WHERE id=?').get(runId)!;
}

async function executeAutomationRun(auto: ReturnType<typeof serializeAutomation>, convId: string, runId: string) {
  const db = getDb();
  const cfg = getConfig();

  try {
    if (auto.type === 'scheduled') {
      const def = auto.definition as ScheduledDefinition;
      await callLiteLLM(convId, def.model, def.system_prompt, def.user_prompt, cfg.litellm.base_url, cfg.litellm.api_key);
    } else {
      const def = auto.definition as PipelineDefinition;
      for (const step of def.steps ?? []) {
        await callLiteLLM(convId, step.model, step.system_prompt, step.user_prompt, cfg.litellm.base_url, cfg.litellm.api_key);
      }
    }
    db.query('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
  } catch (e) {
    db.query('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(e), runId);
  }
}

async function callLiteLLM(
  convId: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl: string,
  apiKey: string,
) {
  const db = getDb();
  const msgId = generateId();

  const userContent = JSON.stringify([{ type: 'text', text: userPrompt }]);
  db.query('INSERT INTO messages (id, conversation_id, role, content, content_text, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(msgId, convId, 'user', userContent, userPrompt, 'done');

  const messages: unknown[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userPrompt });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) throw new Error(`LiteLLM error: ${res.status}`);

  const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  const assistantText = data.choices[0]?.message?.content ?? '';
  const assistantContent = JSON.stringify([{ type: 'text', text: assistantText }]);

  db.query(
    'INSERT INTO messages (id, conversation_id, role, content, content_text, model, tokens_in, tokens_out, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    generateId(), convId, 'assistant', assistantContent, assistantText,
    model, data.usage?.prompt_tokens ?? null, data.usage?.completion_tokens ?? null, 'done',
  );
}
