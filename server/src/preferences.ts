import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb } from './db/index';
import type { SessionPayload, UserPrefRow } from './types';

export const preferencesRouter = new Hono();
preferencesRouter.use('*', requireAuth);

preferencesRouter.get('/', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const rows = db.query<UserPrefRow, [string]>(
    'SELECT key, value FROM user_preferences WHERE user_sub=?'
  ).all(user.sub);

  const prefs: Record<string, string> = {
    sound_enabled: 'true',
    sound_volume: '0.6',
    default_model_id: '',
    default_system_prompt: '',
  };
  for (const row of rows) {
    prefs[row.key] = row.value;
  }
  return c.json(prefs);
});

preferencesRouter.put('/:key', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { value: string };
  const db = getDb();
  db.query(
    `INSERT INTO user_preferences (user_sub, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_sub, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(user.sub, c.req.param('key'), body.value, Date.now());
  return c.body(null, 204);
});
