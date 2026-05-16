import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import type { SystemPromptRow } from './types';

export const promptsRouter = new Hono();
promptsRouter.use('*', requireAuth);

function serializePrompt(row: SystemPromptRow) {
  return {
    ...row,
    visible_to: row.visible_to ? JSON.parse(row.visible_to) : null,
  };
}

promptsRouter.get('/', (c) => {
  const user = c.get('user');
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM system_prompts
    WHERE deleted_at IS NULL
      AND (
        owner_sub = ?
        OR (
          owner_sub IS NULL
          AND (
            visible_to IS NULL
            OR EXISTS (SELECT 1 FROM json_each(visible_to) WHERE value = ?)
          )
        )
      )
    ORDER BY owner_sub ASC, name ASC
  `).all(user.sub, user.role) as SystemPromptRow[];
  return c.json(rows.map(serializePrompt));
});

promptsRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { name: string; content: string };
  const db = getDb();
  const id = generateId();
  db.prepare('INSERT INTO system_prompts (id, owner_sub, name, content) VALUES (?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.content);
  const row = db.prepare('SELECT * FROM system_prompts WHERE id=?').get(id) as SystemPromptRow;
  return c.json(serializePrompt(row), 201);
});

promptsRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { name?: string; content?: string };
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.prepare(
    'SELECT owner_sub FROM system_prompts WHERE id=?'
  ).get(id) as { owner_sub: string } | undefined;
  if (!existing || existing.owner_sub !== user.sub) return c.json({ error: 'Not found' }, 404);

  const updates: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined)    { updates.push('name=?');    vals.push(body.name); }
  if (body.content !== undefined) { updates.push('content=?'); vals.push(body.content); }
  if (updates.length > 0) db.prepare(`UPDATE system_prompts SET ${updates.join(', ')} WHERE id=?`).run(...vals, id);

  const row = db.prepare('SELECT * FROM system_prompts WHERE id=?').get(id) as SystemPromptRow;
  return c.json(serializePrompt(row));
});

promptsRouter.delete('/:id', (c) => {
  const user = c.get('user');
  const db = getDb();
  db.prepare('DELETE FROM system_prompts WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
