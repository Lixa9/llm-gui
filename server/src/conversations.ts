import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { getDb, generateId, runTransaction, safeParseJson } from './db/index';
import type { TxDb } from './db/index';
import type { ConversationRow, MessageRow } from './types';
import { deleteUploadsForConversation, deleteAllUploadsForUser } from './uploads';

export const conversationsRouter = new Hono();
conversationsRouter.use('*', requireAuth);

const conversationFields = {
  model_id: z.string().trim().min(1).max(300).nullable().optional(),
  preset_id: z.string().uuid().nullable().optional(),
  system_prompt_id: z.string().uuid().nullable().optional(),
  custom_system_prompt: z.string().max(100_000).nullable().optional(),
  folder_id: z.string().uuid().nullable().optional(),
} as const;
const conversationCreateSchema = z.object(conversationFields);
const conversationPatchSchema = z.object({
  ...conversationFields,
  title: z.string().max(500).optional(),
  pinned: z.boolean().optional(),
});

function serializeConversation(row: ConversationRow) {
  return { ...row, title_auto: Boolean(row.title_auto), pinned: Boolean(row.pinned) };
}

function serializeMessage(row: MessageRow) {
  return { ...row, content: safeParseJson<unknown[]>(row.content, []) };
}

async function checkPromptAccess(db: TxDb | ReturnType<typeof getDb>, promptId: string, userSub: string, userRole: string): Promise<boolean> {
  const row = await db.prepare('SELECT owner_sub, visible_to FROM system_prompts WHERE id=? AND deleted_at IS NULL').get<{ owner_sub: string | null; visible_to: unknown }>(promptId);
  if (!row) return false;
  if (row.owner_sub) return row.owner_sub === userSub;
  const roles = safeParseJson<string[] | null>(row.visible_to, null);
  return !roles || roles.includes(userRole);
}

async function checkPresetAccess(db: TxDb | ReturnType<typeof getDb>, presetId: string, userSub: string, userRole: string): Promise<boolean> {
  const row = await db.prepare('SELECT owner_sub, visible_to FROM model_presets WHERE id=? AND deleted_at IS NULL').get<{ owner_sub: string | null; visible_to: unknown }>(presetId);
  if (!row) return false;
  if (row.owner_sub) return row.owner_sub === userSub;
  const roles = safeParseJson<string[] | null>(row.visible_to, null);
  return !roles || roles.includes(userRole);
}

async function checkFolderAccess(db: TxDb | ReturnType<typeof getDb>, folderId: string | null, userSub: string): Promise<boolean> {
  if (!folderId) return true;
  return !!await db.prepare('SELECT id FROM conversation_folders WHERE id=? AND owner_sub=?').get(folderId, userSub);
}

async function copyMessages(db: TxDb, srcId: string, destId: string, stopAtMsgId?: string): Promise<void> {
  const messages = await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp, id').all<MessageRow>(srcId);
  for (const message of messages) {
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), destId, message.role, message.content, message.content_text, message.model, message.status, message.timestamp);
    if (stopAtMsgId && message.id === stopAtMsgId) break;
  }
}

conversationsRouter.get('/', async (c) => {
  const rows = await getDb().prepare(`
    SELECT c.*, f.name AS folder_name FROM conversations c
    LEFT JOIN conversation_folders f ON c.folder_id=f.id AND f.owner_sub=c.owner_sub
    WHERE c.owner_sub=? ORDER BY c.pinned DESC, c.created_at DESC
  `).all<ConversationRow>(c.get('user').sub);
  return c.json(rows.map(serializeConversation));
});

conversationsRouter.get('/search', async (c) => {
  const query = (c.req.query('q') ?? '').trim().slice(0, 200);
  if (!query) return c.json([]);
  const rows = await getDb().prepare(`
    SELECT DISTINCT conv.*,
      ts_rank(to_tsvector('simple', m.content_text), websearch_to_tsquery('simple', ?)) AS rank
    FROM conversations conv JOIN messages m ON m.conversation_id=conv.id
    WHERE conv.owner_sub=? AND to_tsvector('simple', m.content_text) @@ websearch_to_tsquery('simple', ?)
    ORDER BY rank DESC LIMIT 20
  `).all<ConversationRow>(query, c.get('user').sub, query);
  return c.json(rows.map(serializeConversation));
});

conversationsRouter.post('/', async (c) => {
  const user = c.get('user');
  const parsedBody = conversationCreateSchema.safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'Invalid conversation' }, 400);
  const body = parsedBody.data;
  const db = getDb();
  if (body.folder_id !== undefined && !await checkFolderAccess(db, body.folder_id, user.sub)) return c.json({ error: 'Folder not available' }, 403);
  if (body.preset_id && !await checkPresetAccess(db, body.preset_id, user.sub, user.role)) return c.json({ error: 'Preset not available' }, 403);
  if (body.system_prompt_id && !await checkPromptAccess(db, body.system_prompt_id, user.sub, user.role)) return c.json({ error: 'System prompt not available' }, 403);
  const id = generateId();
  await db.prepare(`
    INSERT INTO conversations (id, owner_sub, model_id, preset_id, system_prompt_id, custom_system_prompt, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.sub, body.model_id ?? null, body.preset_id ?? null, body.system_prompt_id ?? null, body.custom_system_prompt ?? null, body.folder_id ?? null);
  const row = await db.prepare('SELECT * FROM conversations WHERE id=?').get<ConversationRow>(id);
  if (!row) return c.json({ error: 'Failed to create conversation' }, 500);
  return c.json(serializeConversation(row), 201);
});

conversationsRouter.get('/:id', async (c) => {
  const row = await getDb().prepare('SELECT * FROM conversations WHERE id=? AND owner_sub=?').get<ConversationRow>(c.req.param('id'), c.get('user').sub);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeConversation(row));
});

conversationsRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const parsedBody = conversationPatchSchema.safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'Invalid conversation' }, 400);
  const body = parsedBody.data;
  const db = getDb();
  if (!await db.prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(id, user.sub)) return c.json({ error: 'Not found' }, 404);
  if (body.folder_id !== undefined && !await checkFolderAccess(db, body.folder_id, user.sub)) return c.json({ error: 'Folder not available' }, 403);
  if (body.preset_id !== undefined && body.preset_id !== null && !await checkPresetAccess(db, body.preset_id, user.sub, user.role)) return c.json({ error: 'Preset not available' }, 403);
  if (body.system_prompt_id !== undefined && body.system_prompt_id !== null && !await checkPromptAccess(db, body.system_prompt_id, user.sub, user.role)) return c.json({ error: 'System prompt not available' }, 403);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) { updates.push('title=?', 'title_auto=false'); values.push(body.title); }
  if (body.folder_id !== undefined) { updates.push('folder_id=?'); values.push(body.folder_id); }
  if (body.pinned !== undefined) { updates.push('pinned=?'); values.push(body.pinned); }
  if (body.custom_system_prompt !== undefined) { updates.push('custom_system_prompt=?'); values.push(body.custom_system_prompt); }
  if (body.model_id !== undefined) { updates.push('model_id=?'); values.push(body.model_id); }
  if (body.preset_id !== undefined) { updates.push('preset_id=?'); values.push(body.preset_id); }
  if (body.system_prompt_id !== undefined) { updates.push('system_prompt_id=?'); values.push(body.system_prompt_id); }
  if (updates.length) {
    values.push(id, user.sub);
    await db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id=? AND owner_sub=?`).run(...values);
  }
  const row = await db.prepare('SELECT * FROM conversations WHERE id=?').get<ConversationRow>(id);
  return row ? c.json(serializeConversation(row)) : c.json({ error: 'Not found' }, 404);
});

conversationsRouter.delete('/', async (c) => {
  const user = c.get('user');
  await deleteAllUploadsForUser(user.sub);
  await getDb().prepare('DELETE FROM conversations WHERE owner_sub=?').run(user.sub);
  return c.body(null, 204);
});

conversationsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await deleteUploadsForConversation(id, user.sub);
  await getDb().prepare('DELETE FROM conversations WHERE id=? AND owner_sub=?').run(id, user.sub);
  return c.body(null, 204);
});

conversationsRouter.post('/:id/duplicate', async (c) => {
  const user = c.get('user');
  const src = await getDb().prepare('SELECT * FROM conversations WHERE id=? AND owner_sub=?').get<ConversationRow>(c.req.param('id'), user.sub);
  if (!src) return c.json({ error: 'Not found' }, 404);
  const copy = await runTransaction(async db => {
    const id = generateId();
    await db.prepare(`
      INSERT INTO conversations (id, owner_sub, title, model_id, preset_id, system_prompt_id, custom_system_prompt, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.sub, `${src.title} (copy)`, src.model_id, src.preset_id, src.system_prompt_id, src.custom_system_prompt, src.folder_id);
    await copyMessages(db, src.id, id);
    return db.prepare('SELECT * FROM conversations WHERE id=?').get<ConversationRow>(id);
  });
  return copy ? c.json(serializeConversation(copy), 201) : c.json({ error: 'Failed to duplicate' }, 500);
});

conversationsRouter.post('/:id/fork', async (c) => {
  const user = c.get('user');
  const parsedBody = z.object({ message_id: z.string().uuid() }).safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'message_id is required' }, 400);
  const body = parsedBody.data;
  const src = await getDb().prepare('SELECT * FROM conversations WHERE id=? AND owner_sub=?').get<ConversationRow>(c.req.param('id'), user.sub);
  if (!src) return c.json({ error: 'Not found' }, 404);
  const fork = await runTransaction(async db => {
    const id = generateId();
    await db.prepare(`
      INSERT INTO conversations (id, owner_sub, title, model_id, preset_id, system_prompt_id, custom_system_prompt, forked_from_id, forked_at_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.sub, `Fork of: ${src.title}`, src.model_id, src.preset_id, src.system_prompt_id, src.custom_system_prompt, src.id, body.message_id);
    await copyMessages(db, src.id, id, body.message_id);
    return db.prepare('SELECT * FROM conversations WHERE id=?').get<ConversationRow>(id);
  });
  return fork ? c.json(serializeConversation(fork), 201) : c.json({ error: 'Failed to fork' }, 500);
});

conversationsRouter.get('/:id/messages', async (c) => {
  const user = c.get('user');
  if (!await getDb().prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(c.req.param('id'), user.sub)) return c.json({ error: 'Not found' }, 404);
  const rows = await getDb().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp, id').all<MessageRow>(c.req.param('id'));
  return c.json(rows.map(serializeMessage));
});

conversationsRouter.patch('/:id/messages/:msgId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json() as { content?: unknown };
  if (typeof body.content !== 'string' || body.content.length > 1_000_000) return c.json({ error: 'Invalid message content' }, 400);
  if (!await getDb().prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(id, user.sub)) return c.json({ error: 'Not found' }, 404);
  await getDb().prepare('UPDATE messages SET content=?, content_text=?, edited_at=? WHERE id=? AND conversation_id=?')
    .run(JSON.stringify([{ type: 'text', text: body.content }]), body.content, Date.now(), c.req.param('msgId'), id);
  const row = await getDb().prepare('SELECT * FROM messages WHERE id=?').get<MessageRow>(c.req.param('msgId'));
  return row ? c.json(serializeMessage(row)) : c.json({ error: 'Not found' }, 404);
});

conversationsRouter.delete('/:id/messages/:msgId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!await getDb().prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(id, user.sub)) return c.json({ error: 'Not found' }, 404);
  const message = await getDb().prepare('SELECT timestamp FROM messages WHERE id=? AND conversation_id=?').get<{ timestamp: number }>(c.req.param('msgId'), id);
  if (!message) return c.body(null, 204);
  await getDb().prepare('DELETE FROM messages WHERE conversation_id=? AND timestamp>=?').run(id, message.timestamp);
  return c.body(null, 204);
});
