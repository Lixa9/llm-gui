import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import type { SessionPayload, ModelPresetRow } from './types';

export const presetsRouter = new Hono();
presetsRouter.use('*', requireAuth);

presetsRouter.get('/', (c) => {
  const user = c.get('user');
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM model_presets WHERE deleted_at IS NULL AND (
      owner_sub = ?
      OR (owner_sub IS NULL AND (visible_to IS NULL OR EXISTS (SELECT 1 FROM json_each(visible_to) WHERE value = ?)))
    )
    ORDER BY owner_sub IS NULL DESC, name
  `).all(user.sub, user.role) as ModelPresetRow[];
  return c.json(rows);
});

presetsRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as Pick<ModelPresetRow, 'name' | 'base_model_id' | 'system_prompt'>;
  const db = getDb();
  const id = generateId();
  db.prepare('INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.base_model_id, body.system_prompt ?? '');
  const row = db.prepare('SELECT * FROM model_presets WHERE id=?').get(id) as ModelPresetRow;
  return c.json(row, 201);
});

presetsRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as Partial<Pick<ModelPresetRow, 'name' | 'base_model_id' | 'system_prompt'>>;
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.prepare('SELECT owner_sub FROM model_presets WHERE id=?').get(id) as { owner_sub: string } | undefined;
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  const updates: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined)          { updates.push('name=?');          vals.push(body.name); }
  if (body.base_model_id !== undefined) { updates.push('base_model_id=?'); vals.push(body.base_model_id); }
  if (body.system_prompt !== undefined) { updates.push('system_prompt=?'); vals.push(body.system_prompt); }
  if (updates.length > 0) db.prepare(`UPDATE model_presets SET ${updates.join(', ')} WHERE id=?`).run(...vals, id);

  const row = db.prepare('SELECT * FROM model_presets WHERE id=?').get(id) as ModelPresetRow;
  return c.json(row);
});

presetsRouter.delete('/:id', (c) => {
  const user = c.get('user');
  const db = getDb();
  db.prepare('DELETE FROM model_presets WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
