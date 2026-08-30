import { Hono } from 'hono';
import { requireRole } from './auth.ts';
import { getDb, safeParseJson } from './db/index.ts';
import type { SystemPromptRow, AutomationRow } from './types.ts';

export const adminRouter = new Hono();
adminRouter.use('*', requireRole('admin'));

adminRouter.get('/prompts', async (c) => {
  const rows = await getDb().prepare('SELECT * FROM system_prompts WHERE deleted_at IS NULL ORDER BY owner_sub ASC, name ASC').all<SystemPromptRow>();
  return c.json(rows.map(row => ({ ...row, visible_to: safeParseJson<string[] | null>(row.visible_to, null) })));
});

adminRouter.get('/automations', async (c) => {
  const rows = await getDb().prepare('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY owner_sub ASC, name ASC').all<AutomationRow>();
  return c.json(rows.map(row => ({ ...row, enabled: Boolean(row.enabled), definition: safeParseJson<Record<string, unknown>>(row.definition, {}) })));
});
