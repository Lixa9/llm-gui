import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import type { SessionPayload, ConversationRow, MessageRow } from './types';

export const conversationsRouter = new Hono();
conversationsRouter.use('*', requireAuth);

function serializeConversation(row: ConversationRow) {
  return {
    ...row,
    title_auto: row.title_auto === 1,
    pinned: row.pinned === 1,
  };
}

function serializeMessage(row: MessageRow) {
  return {
    ...row,
    content: JSON.parse(row.content),
    tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : null,
    tool_results: row.tool_results ? JSON.parse(row.tool_results) : null,
  };
}

// List conversations
conversationsRouter.get('/', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const rows = db.query<ConversationRow, [string]>(
    `SELECT c.*, f.name as folder_name
     FROM conversations c
     LEFT JOIN conversation_folders f ON c.folder_id = f.id
     WHERE c.owner_sub = ?
     ORDER BY c.pinned DESC, c.created_at DESC`
  ).all(user.sub);
  return c.json(rows.map(serializeConversation));
});

// Search
conversationsRouter.get('/search', async (c) => {
  const user = c.get('user') as SessionPayload;
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json([]);

  const db = getDb();
  const query = q.trim().split(/\s+/).map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');

  const rows = db.query<ConversationRow, [string, string]>(`
    SELECT DISTINCT conv.* FROM conversations conv
    JOIN messages m ON m.conversation_id = conv.id
    JOIN messages_fts fts ON fts.rowid = m.rowid
    WHERE messages_fts MATCH ?
      AND conv.owner_sub = ?
    ORDER BY rank
    LIMIT 20
  `).all(query, user.sub);

  return c.json(rows.map(serializeConversation));
});

// Create
conversationsRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as Partial<ConversationRow>;
  const db = getDb();
  const id = generateId();
  db.query(
    `INSERT INTO conversations (id, owner_sub, model_id, system_prompt_id, custom_system_prompt, folder_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, user.sub, body.model_id ?? null, body.system_prompt_id ?? null, body.custom_system_prompt ?? null, body.folder_id ?? null);
  const row = db.query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id=?').get(id)!;
  return c.json(serializeConversation(row), 201);
});

// Get single
conversationsRouter.get('/:id', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const row = db.query<ConversationRow, [string, string]>(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeConversation(row));
});

// Update
conversationsRouter.patch('/:id', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as Partial<ConversationRow>;
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.query<ConversationRow, [string, string]>(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(id, user.sub);
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) { updates.push('title=?, title_auto=0'); vals.push(body.title); }
  if (body.folder_id !== undefined) { updates.push('folder_id=?'); vals.push(body.folder_id ?? null); }
  if (body.pinned !== undefined) { updates.push('pinned=?'); vals.push(body.pinned ? 1 : 0); }
  if (body.custom_system_prompt !== undefined) { updates.push('custom_system_prompt=?'); vals.push(body.custom_system_prompt); }
  if (body.model_id !== undefined) { updates.push('model_id=?'); vals.push(body.model_id); }

  if (updates.length > 0) {
    vals.push(id);
    db.query(`UPDATE conversations SET ${updates.join(', ')} WHERE id=?`).run(...vals);
  }

  const updated = db.query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id=?').get(id)!;
  return c.json(serializeConversation(updated));
});

// Delete
conversationsRouter.delete('/:id', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const id = c.req.param('id');
  db.query('DELETE FROM conversations WHERE id=? AND owner_sub=?').run(id, user.sub);
  return c.body(null, 204);
});

// Duplicate
conversationsRouter.post('/:id/duplicate', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const src = db.query<ConversationRow, [string, string]>(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!src) return c.json({ error: 'Not found' }, 404);

  const newId = generateId();
  db.query(
    `INSERT INTO conversations (id, owner_sub, title, model_id, system_prompt_id, custom_system_prompt, folder_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId, user.sub, `${src.title} (copy)`, src.model_id, src.system_prompt_id, src.custom_system_prompt, src.folder_id);

  // Copy messages
  const msgs = db.query<MessageRow, [string]>('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp').all(src.id);
  for (const m of msgs) {
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, content_text, tool_calls, tool_results, model, tokens_in, tokens_out, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId(), newId, m.role, m.content, m.content_text, m.tool_calls, m.tool_results, m.model, m.tokens_in, m.tokens_out, m.status, m.timestamp);
  }

  const newConv = db.query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id=?').get(newId)!;
  return c.json(serializeConversation(newConv), 201);
});

// Fork
conversationsRouter.post('/:id/fork', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { message_id: string };
  const db = getDb();
  const src = db.query<ConversationRow, [string, string]>(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!src) return c.json({ error: 'Not found' }, 404);

  const newId = generateId();
  db.query(
    `INSERT INTO conversations (id, owner_sub, title, model_id, system_prompt_id, custom_system_prompt, forked_from_id, forked_at_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId, user.sub, `Fork of: ${src.title}`, src.model_id, src.system_prompt_id, src.custom_system_prompt, src.id, body.message_id);

  // Copy messages up to and including the fork point
  const msgs = db.query<MessageRow, [string]>(
    'SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp'
  ).all(src.id);

  let include = true;
  for (const m of msgs) {
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, content_text, tool_calls, tool_results, model, tokens_in, tokens_out, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId(), newId, m.role, m.content, m.content_text, m.tool_calls, m.tool_results, m.model, m.tokens_in, m.tokens_out, m.status, m.timestamp);
    if (m.id === body.message_id) break;
  }

  const newConv = db.query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id=?').get(newId)!;
  return c.json(serializeConversation(newConv), 201);
});

// Messages
conversationsRouter.get('/:id/messages', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const conv = db.query<{ id: string }, [string, string]>(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const rows = db.query<MessageRow, [string]>(
    'SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp'
  ).all(c.req.param('id'));
  return c.json(rows.map(serializeMessage));
});

// Edit message
conversationsRouter.patch('/:id/messages/:msgId', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { content: string };
  const db = getDb();
  const conv = db.query<{ id: string }, [string, string]>(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const newContent = JSON.stringify([{ type: 'text', text: body.content }]);
  db.query(
    'UPDATE messages SET content=?, content_text=?, edited_at=? WHERE id=? AND conversation_id=?'
  ).run(newContent, body.content, Date.now(), c.req.param('msgId'), c.req.param('id'));

  const row = db.query<MessageRow, [string]>('SELECT * FROM messages WHERE id=?').get(c.req.param('msgId'))!;
  return c.json(serializeMessage(row));
});

// Delete message and all after it
conversationsRouter.delete('/:id/messages/:msgId', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const conv = db.query<{ id: string }, [string, string]>(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const msg = db.query<{ timestamp: number }, [string]>(
    'SELECT timestamp FROM messages WHERE id=?'
  ).get(c.req.param('msgId'));
  if (!msg) return c.body(null, 204);

  db.query(
    'DELETE FROM messages WHERE conversation_id=? AND timestamp >= ?'
  ).run(c.req.param('id'), msg.timestamp);

  return c.body(null, 204);
});

// Folders router
export const foldersRouter = new Hono();
foldersRouter.use('*', requireAuth);

foldersRouter.get('/', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  const rows = db.query('SELECT * FROM conversation_folders WHERE owner_sub=? ORDER BY name').all(user.sub);
  return c.json(rows);
});

foldersRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { name: string; parent_id?: string };
  const db = getDb();
  const id = generateId();
  db.query('INSERT INTO conversation_folders (id, owner_sub, name, parent_id) VALUES (?, ?, ?, ?)')
    .run(id, user.sub, body.name, body.parent_id ?? null);
  const row = db.query('SELECT * FROM conversation_folders WHERE id=?').get(id);
  return c.json(row, 201);
});

foldersRouter.patch('/:id', async (c) => {
  const user = c.get('user') as SessionPayload;
  const body = await c.req.json() as { name?: string; parent_id?: string };
  const db = getDb();
  const id = c.req.param('id');
  if (body.name !== undefined) {
    db.query('UPDATE conversation_folders SET name=? WHERE id=? AND owner_sub=?').run(body.name, id, user.sub);
  }
  if (body.parent_id !== undefined) {
    db.query('UPDATE conversation_folders SET parent_id=? WHERE id=? AND owner_sub=?').run(body.parent_id ?? null, id, user.sub);
  }
  const row = db.query('SELECT * FROM conversation_folders WHERE id=?').get(id);
  return c.json(row);
});

foldersRouter.delete('/:id', (c) => {
  const user = c.get('user') as SessionPayload;
  const db = getDb();
  db.query('DELETE FROM conversation_folders WHERE id=? AND owner_sub=?').run(c.req.param('id'), user.sub);
  return c.body(null, 204);
});
