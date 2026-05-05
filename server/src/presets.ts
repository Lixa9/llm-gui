import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import type { SessionPayload, ModelPresetRow } from './types';

export const presetsRouter = new Hono();
presetsRouter.use('*', requireAuth);

presetsRouter.get('/', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const rows = db.query<ModelPresetRow, [string]>(
    'SELECT * FROM model_presets WHERE owner_sub=? ORDER BY name'
  ).all(user.sub);
  return c.json(rows);
});

presetsRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as Pick<ModelPresetRow, 'name' | 'base_model_id' | 'system_prompt'>;
  const db = getDb();
  const id = generateId();
  db.query('INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.base_model_id, body.system_prompt ?? '');
  const row = db.query<ModelPresetRow, [string]>('SELECT * FROM model_presets WHERE id=?').get(id)!;
  return c.json(row, 201);
});

presetsRouter.patch('/:id', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as Partial<Pick<ModelPresetRow, 'name' | 'base_model_id' | 'system_prompt'>>;
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.query<{ owner_sub: string }, [string]>('SELECT owner_sub FROM model_presets WHERE id=?').get(id);
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  if (body.name !== undefined) db.query('UPDATE model_presets SET name=? WHERE id=?').run(body.name, id);
  if (body.base_model_id !== undefined) db.query('UPDATE model_presets SET base_model_id=? WHERE id=?').run(body.base_model_id, id);
  if (body.system_prompt !== undefined) db.query('UPDATE model_presets SET system_prompt=? WHERE id=?').run(body.system_prompt, id);

  const row = db.query<ModelPresetRow, [string]>('SELECT * FROM model_presets WHERE id=?').get(id)!;
  return c.json(row);
});

presetsRouter.delete('/:id', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  db.query('DELETE FROM model_presets WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
