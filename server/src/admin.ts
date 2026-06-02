import { Hono } from 'hono';
import { requireRole } from './auth';
import { getDb } from './db/index';
import { getConfig, isConfigWritable, getConfigFileContent, writeConfigFile, CONFIG_FILES } from './config';
import type { UserRow, SystemPromptRow, AutomationRow } from './types';

export const adminRouter = new Hono();
adminRouter.use('*', requireRole('admin'));

// config.yaml contains secrets and core deployment info, do not expose to the web UI
const EDITABLE_CONFIG_FILES = CONFIG_FILES.filter(f => f !== 'config.yaml');

adminRouter.get('/prompts', (c) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM system_prompts WHERE deleted_at IS NULL ORDER BY owner_sub ASC, name ASC'
  ).all() as SystemPromptRow[];
  return c.json(rows.map(r => ({ ...r, visible_to: r.visible_to ? JSON.parse(r.visible_to) : null })));
});

adminRouter.get('/automations', (c) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY owner_sub ASC, name ASC'
  ).all() as AutomationRow[];
  return c.json(rows.map(r => ({ ...r, enabled: r.enabled === 1, definition: JSON.parse(r.definition) })));
});

adminRouter.get('/config', (c) => {
  const files = EDITABLE_CONFIG_FILES.map(name => ({
    name,
    content: getConfigFileContent(name),
    writable: isConfigWritable(name),
  }));
  return c.json(files);
});

adminRouter.put('/config/:file', async (c) => {
  const name = c.req.param('file');
  if (!EDITABLE_CONFIG_FILES.includes(name)) return c.json({ error: 'Invalid file' }, 400);
  if (!isConfigWritable(name)) return c.json({ error: 'Config is read-only' }, 403);

  const body = await c.req.json() as { content: string };
  try {
    writeConfigFile(name, body.content);
  } catch (e) {
    return c.json({ error: `Config validation failed: ${(e as Error).message}` }, 400);
  }
  return c.body(null, 204);
});
