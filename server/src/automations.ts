import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId, safeParseJson } from './db/index';
import { automationSchema, nextRunAt, scheduledDefinitionSchema } from './automation-definition';
import { runAutomation } from './automation-runner';
import type { AutomationRow, AutomationRunRow } from './types';

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
  await getDb().prepare('INSERT INTO automations (id, owner_sub, name, type, definition, next_run_at) VALUES (?, ?, ?, ?, ?::jsonb, ?)')
    .run(id, user.sub, parsed.data.name, 'scheduled', JSON.stringify(parsed.data.definition), nextRunAt(parsed.data.definition));
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
  const definition = body.definition === undefined ? undefined : scheduledDefinitionSchema.safeParse(body.definition);
  if (definition && !definition.success) return c.json({ error: definition.error.issues[0]?.message ?? 'Invalid definition' }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid enabled value' }, 400);
  const nextRun = definition?.success ? nextRunAt(definition.data) : undefined;
  await getDb().prepare(`
    UPDATE automations SET name=COALESCE(?, name), definition=COALESCE(?::jsonb, definition), enabled=COALESCE(?, enabled), next_run_at=COALESCE(?, next_run_at)
    WHERE id=? AND owner_sub=?
  `).run(typeof body.name === 'string' ? body.name.trim() : undefined, definition?.success ? JSON.stringify(definition.data) : undefined, body.enabled, nextRun, id, user.sub);
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
  const visible = await getDb().prepare('SELECT id FROM automations WHERE id=? AND owner_sub IS NULL AND deleted_at IS NULL AND (visible_to IS NULL OR visible_to @> to_jsonb(?::text))').get(c.req.param('id'), user.role);
  if (!visible) return c.json({ error: 'Not found' }, 404);
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
