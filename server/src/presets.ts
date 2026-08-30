import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth.ts';
import { getDb, generateId } from './db/index.ts';
import type { ModelPresetRow } from './types.ts';

const presetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  base_model_id: z.string().trim().min(1).max(300),
  system_prompt: z.string().max(100_000).default(''),
});

export const presetsRouter = new Hono();
presetsRouter.use('*', requireAuth);

presetsRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await getDb().prepare(`
    SELECT * FROM model_presets WHERE deleted_at IS NULL AND (
      owner_sub = ? OR (owner_sub IS NULL AND (visible_to IS NULL OR visible_to @> to_jsonb(?::text)))
    ) ORDER BY owner_sub IS NULL DESC, name
  `).all<ModelPresetRow>(user.sub, user.role);
  return c.json(rows);
});

presetsRouter.post('/', async (c) => {
  const parsed = presetSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid preset' }, 400);
  const user = c.get('user');
  const id = generateId();
  await getDb().prepare('INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.sub, parsed.data.name, parsed.data.base_model_id, parsed.data.system_prompt);
  const row = await getDb().prepare('SELECT * FROM model_presets WHERE id=?').get<ModelPresetRow>(id);
  if (!row) return c.json({ error: 'Failed to create preset' }, 500);
  return c.json(row, 201);
});

presetsRouter.patch('/:id', async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const user = c.get('user');
  const existing = await getDb().prepare('SELECT owner_sub FROM model_presets WHERE id=?').get<{ owner_sub: string | null }>(c.req.param('id'));
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);
  const name = body.name === undefined ? undefined : z.string().trim().min(1).max(200).safeParse(body.name);
  const baseModel = body.base_model_id === undefined ? undefined : z.string().trim().min(1).max(300).safeParse(body.base_model_id);
  const systemPrompt = body.system_prompt === undefined ? undefined : z.string().max(100_000).safeParse(body.system_prompt);
  if (name && !name.success || baseModel && !baseModel.success || systemPrompt && !systemPrompt.success) return c.json({ error: 'Invalid preset' }, 400);
  await getDb().prepare(`
    UPDATE model_presets SET name=COALESCE(?, name), base_model_id=COALESCE(?, base_model_id),
      system_prompt=COALESCE(?, system_prompt) WHERE id=? AND owner_sub=?
  `).run(name?.data, baseModel?.data, systemPrompt?.data, c.req.param('id'), user.sub);
  const row = await getDb().prepare('SELECT * FROM model_presets WHERE id=?').get<ModelPresetRow>(c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

presetsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  await getDb().prepare('DELETE FROM model_presets WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
