import { Hono } from 'hono';
import { requireAuth } from './auth.ts';
import { getDb } from './db/index.ts';
import type { UserPrefRow } from './types.ts';

const ALLOWED_PREF_KEYS = new Set(['sound_enabled', 'sound_volume', 'default_model_id', 'default_preset_id', 'theme']);
const MAX_PREF_VALUE_LEN = 4096;
export const preferencesRouter = new Hono();
preferencesRouter.use('*', requireAuth);

preferencesRouter.get('/', async (c) => {
  const rows = await getDb().prepare('SELECT key, value FROM user_preferences WHERE user_sub=?').all<UserPrefRow>(c.get('user').sub);
  const prefs: Record<string, string> = { sound_enabled: 'true', sound_volume: '0.6', default_model_id: '', default_preset_id: '', theme: '' };
  for (const row of rows) prefs[row.key] = row.value;
  return c.json(prefs);
});

preferencesRouter.put('/:key', async (c) => {
  const key = c.req.param('key');
  if (!ALLOWED_PREF_KEYS.has(key)) return c.json({ error: 'Unknown preference key' }, 400);
  const body = await c.req.json() as { value?: unknown };
  if (typeof body.value !== 'string' || body.value.length > MAX_PREF_VALUE_LEN) return c.json({ error: 'Invalid value' }, 400);
  await getDb().prepare(`
    INSERT INTO user_preferences (user_sub, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_sub, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(c.get('user').sub, key, body.value, Date.now());
  return c.body(null, 204);
});
