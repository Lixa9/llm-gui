import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';

const folderName = z.string().trim().min(1).max(200);
export const foldersRouter = new Hono();
foldersRouter.use('*', requireAuth);

foldersRouter.get('/', async (c) => {
  const rows = await getDb().prepare('SELECT * FROM conversation_folders WHERE owner_sub=? ORDER BY name').all(c.get('user').sub);
  return c.json(rows);
});

async function validateParent(id: string, parentId: string | null, ownerSub: string): Promise<boolean> {
  if (!parentId) return true;
  if (id === parentId) return false;
  const parent = await getDb().prepare('SELECT id FROM conversation_folders WHERE id=? AND owner_sub=?').get(parentId, ownerSub);
  if (!parent) return false;
  let current = parentId;
  for (let depth = 0; depth < 100; depth++) {
    const row = await getDb().prepare('SELECT parent_id FROM conversation_folders WHERE id=? AND owner_sub=?').get<{ parent_id: string | null }>(current, ownerSub);
    if (!row?.parent_id) return true;
    if (row.parent_id === id) return false;
    current = row.parent_id;
  }
  return false;
}

foldersRouter.post('/', async (c) => {
  const body = await c.req.json() as { name?: unknown; parent_id?: unknown };
  const parsedName = folderName.safeParse(body.name);
  if (!parsedName.success) return c.json({ error: 'Folder name must be 1–200 characters' }, 400);
  const parentId = body.parent_id === undefined || body.parent_id === null ? null : z.string().uuid().safeParse(body.parent_id);
  if (parentId && !parentId.success) return c.json({ error: 'Invalid parent folder' }, 400);
  const user = c.get('user');
  const id = generateId();
  if (!await validateParent(id, parentId ? parentId.data : null, user.sub)) return c.json({ error: 'Invalid parent folder' }, 400);
  await getDb().prepare('INSERT INTO conversation_folders (id, owner_sub, name, parent_id) VALUES (?, ?, ?, ?)')
    .run(id, user.sub, parsedName.data, parentId ? parentId.data : null);
  const row = await getDb().prepare('SELECT * FROM conversation_folders WHERE id=?').get(id);
  return c.json(row, 201);
});

foldersRouter.patch('/:id', async (c) => {
  const body = await c.req.json() as { name?: unknown; parent_id?: unknown };
  const id = c.req.param('id');
  const user = c.get('user');
  const existing = await getDb().prepare('SELECT id, parent_id FROM conversation_folders WHERE id=? AND owner_sub=?').get<{ id: string; parent_id: string | null }>(id, user.sub);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  let name: string | undefined;
  if (body.name !== undefined) {
    const parsed = folderName.safeParse(body.name);
    if (!parsed.success) return c.json({ error: 'Folder name must be 1–200 characters' }, 400);
    name = parsed.data;
  }
  let parentId: string | null | undefined;
  if (body.parent_id !== undefined) {
    if (body.parent_id === null) parentId = null;
    else {
      const parsed = z.string().uuid().safeParse(body.parent_id);
      if (!parsed.success) return c.json({ error: 'Invalid parent folder' }, 400);
      parentId = parsed.data;
    }
    if (!await validateParent(id, parentId, user.sub)) return c.json({ error: 'Invalid parent folder' }, 400);
  }
  await getDb().prepare('UPDATE conversation_folders SET name=COALESCE(?, name), parent_id=COALESCE(?, parent_id) WHERE id=? AND owner_sub=?')
    .run(name, parentId, id, user.sub);
  if (parentId === null) await getDb().prepare('UPDATE conversation_folders SET parent_id=NULL WHERE id=? AND owner_sub=?').run(id, user.sub);
  const row = await getDb().prepare('SELECT * FROM conversation_folders WHERE id=? AND owner_sub=?').get(id, user.sub);
  return c.json(row);
});

foldersRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  await getDb().prepare('DELETE FROM conversation_folders WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
