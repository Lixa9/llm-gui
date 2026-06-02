import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';

export const foldersRouter = new Hono();
foldersRouter.use('*', requireAuth);

foldersRouter.get('/', (c) => {
  const user = c.get('user');
  const db = getDb();
  const rows = db.prepare('SELECT * FROM conversation_folders WHERE owner_sub=? ORDER BY name').all(user.sub);
  return c.json(rows);
});

foldersRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { name: string; parent_id?: string };
  const db = getDb();
  const id = generateId();
  db.prepare('INSERT INTO conversation_folders (id, owner_sub, name, parent_id) VALUES (?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.parent_id ?? null);
  const row = db.prepare('SELECT * FROM conversation_folders WHERE id=?').get(id);
  return c.json(row, 201);
});

foldersRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { name?: string; parent_id?: string };
  const db = getDb();
  const id = c.req.param('id');
  const updates: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) { updates.push('name=?'); vals.push(body.name); }
  if (body.parent_id !== undefined) { updates.push('parent_id=?'); vals.push(body.parent_id ?? null); }
  if (updates.length > 0) {
    db.prepare(`UPDATE conversation_folders SET ${updates.join(', ')} WHERE id=? AND owner_sub=?`).run(...vals, id, user.sub);
  }
  const row = db.prepare('SELECT * FROM conversation_folders WHERE id=? AND owner_sub=?').get(id, user.sub);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

foldersRouter.delete('/:id', (c) => {
  const user = c.get('user');
  const db = getDb();
  db.prepare('DELETE FROM conversation_folders WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
