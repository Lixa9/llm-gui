import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { getDb, generateId, safeParseJson } from './db/index';
import type { SystemPromptRow } from './types';

const promptSchema = z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(100_000) });
export const promptsRouter = new Hono();
promptsRouter.use('*', requireAuth);

function serializePrompt(row: SystemPromptRow) {
  return { ...row, visible_to: safeParseJson<string[] | null>(row.visible_to, null) };
}

promptsRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await getDb().prepare(`
    SELECT * FROM system_prompts
    WHERE deleted_at IS NULL AND (
      owner_sub = ? OR (owner_sub IS NULL AND (visible_to IS NULL OR visible_to @> to_jsonb(?::text)))
    )
    ORDER BY owner_sub ASC, name ASC
  `).all<SystemPromptRow>(user.sub, user.role);
  return c.json(rows.map(serializePrompt));
});

promptsRouter.post('/', async (c) => {
  const parsed = promptSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid prompt' }, 400);
  const user = c.get('user');
  const id = generateId();
  await getDb().prepare('INSERT INTO system_prompts (id, owner_sub, name, content) VALUES (?, ?, ?, ?)')
    .run(id, user.sub, parsed.data.name, parsed.data.content);
  const row = await getDb().prepare('SELECT * FROM system_prompts WHERE id=?').get<SystemPromptRow>(id);
  if (!row) return c.json({ error: 'Failed to create prompt' }, 500);
  return c.json(serializePrompt(row), 201);
});

promptsRouter.patch('/:id', async (c) => {
  const body = await c.req.json() as { name?: unknown; content?: unknown };
  const user = c.get('user');
  const existing = await getDb().prepare('SELECT owner_sub FROM system_prompts WHERE id=?').get<{ owner_sub: string | null }>(c.req.param('id'));
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);
  const name = body.name === undefined ? undefined : z.string().trim().min(1).max(200).safeParse(body.name);
  const content = body.content === undefined ? undefined : z.string().max(100_000).safeParse(body.content);
  if (name && !name.success || content && !content.success) return c.json({ error: 'Invalid prompt' }, 400);
  if (name || content) {
    await getDb().prepare('UPDATE system_prompts SET name=COALESCE(?, name), content=COALESCE(?, content) WHERE id=? AND owner_sub=?')
      .run(name?.data, content?.data, c.req.param('id'), user.sub);
  }
  const row = await getDb().prepare('SELECT * FROM system_prompts WHERE id=?').get<SystemPromptRow>(c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializePrompt(row));
});

promptsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  await getDb().prepare('DELETE FROM system_prompts WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
