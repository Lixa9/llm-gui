import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId, runTransaction, safeParseJson } from './db/index';
import type { Db } from './db/index';
import type { ConversationRow, MessageRow } from './types';
import { deleteUploadsForConversation, deleteAllUploadsForUser } from './uploads';

export const conversationsRouter = new Hono();
conversationsRouter.use('*', requireAuth);

function serializeConversation(row: ConversationRow) {
  return {
    ...row,
    title_auto: row.title_auto === 1,
    pinned: row.pinned === 1,
  };
}

function checkPromptAccess(db: Db, promptId: string, userSub: string, userRole: string): boolean {
  const row = db.prepare('SELECT owner_sub, visible_to FROM system_prompts WHERE id=?').get(promptId) as { owner_sub: string | null; visible_to: string | null } | undefined;
  if (!row) return false;
  if (row.owner_sub) return row.owner_sub === userSub;
  if (row.visible_to) {
    try {
      const roles = JSON.parse(row.visible_to) as string[];
      return roles.includes(userRole);
    } catch {
      return false;
    }
  }
  return true;
}

function checkPresetAccess(db: Db, presetId: string, userSub: string, userRole: string): boolean {
  const row = db.prepare('SELECT owner_sub, visible_to FROM model_presets WHERE id=?').get(presetId) as { owner_sub: string | null; visible_to: string | null } | undefined;
  if (!row) return false;
  if (row.owner_sub) return row.owner_sub === userSub;
  if (row.visible_to) {
    try {
      const roles = JSON.parse(row.visible_to) as string[];
      return roles.includes(userRole);
    } catch {
      return false;
    }
  }
  return true;
}

function copyMessages(db: Db, srcId: string, destId: string, stopAtMsgId?: string) {
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp').all(srcId) as MessageRow[];
  for (const m of msgs) {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, content_text, tool_calls, model, tokens_in, tokens_out, status, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId(), destId, m.role, m.content, m.content_text, m.tool_calls, m.model, m.tokens_in, m.tokens_out, m.status, m.timestamp);
    if (stopAtMsgId && m.id === stopAtMsgId) break;
  }
}

function serializeMessage(row: MessageRow) {
  return {
    ...row,
    content: safeParseJson<unknown[]>(row.content, []),
    tool_calls: safeParseJson<unknown | null>(row.tool_calls, null),
  };
}

// List conversations
conversationsRouter.get('/', (c) => {
  const user = c.get('user');
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.*, f.name as folder_name
     FROM conversations c
     LEFT JOIN conversation_folders f ON c.folder_id = f.id
     WHERE c.owner_sub = ?
     ORDER BY c.pinned DESC, c.created_at DESC`
  ).all(user.sub) as ConversationRow[];
  return c.json(rows.map(serializeConversation));
});

// Search
conversationsRouter.get('/search', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json([]);

  const db = getDb();
  // Strip FTS5 special chars (quotes, wildcards) so user input is treated as plain words
  const terms = q.trim().slice(0, 200).split(/\s+/)
    .map(w => w.replace(/["*]/g, ''))
    .filter(w => w.length > 0);
  if (!terms.length) return c.json([]);
  const query = terms.map(w => `"${w}"`).join(' OR ');

  const rows = db.prepare(`
    SELECT DISTINCT conv.* FROM conversations conv
    JOIN messages m ON m.conversation_id = conv.id
    JOIN messages_fts fts ON fts.rowid = m.rowid
    WHERE messages_fts MATCH ?
      AND conv.owner_sub = ?
    ORDER BY rank
    LIMIT 20
  `).all(query, user.sub) as ConversationRow[];

  return c.json(rows.map(serializeConversation));
});

// Create
conversationsRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as Partial<ConversationRow>;
  const db = getDb();

  if (body.preset_id && !checkPresetAccess(db, body.preset_id, user.sub, user.role)) {
    return c.json({ error: 'Preset not available' }, 403);
  }
  if (body.system_prompt_id && !checkPromptAccess(db, body.system_prompt_id, user.sub, user.role)) {
    return c.json({ error: 'System prompt not available' }, 403);
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO conversations (id, owner_sub, model_id, preset_id, system_prompt_id, custom_system_prompt, folder_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, user.sub, body.model_id ?? null, body.preset_id ?? null, body.system_prompt_id ?? null, body.custom_system_prompt ?? null, body.folder_id ?? null);
  const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  return c.json(serializeConversation(row), 201);
});

// Get single
conversationsRouter.get('/:id', (c) => {
  const user = c.get('user');
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as ConversationRow | undefined;
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeConversation(row));
});

// Update
conversationsRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as Partial<ConversationRow>;
  const db = getDb();
  const id = c.req.param('id');

  const existing = db.prepare(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(id, user.sub) as { id: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) { updates.push('title=?, title_auto=0'); vals.push(body.title); }
  if (body.folder_id !== undefined) { updates.push('folder_id=?'); vals.push(body.folder_id ?? null); }
  if (body.pinned !== undefined) { updates.push('pinned=?'); vals.push(body.pinned ? 1 : 0); }
  if (body.custom_system_prompt !== undefined) { updates.push('custom_system_prompt=?'); vals.push(body.custom_system_prompt); }
  if (body.model_id !== undefined) { updates.push('model_id=?'); vals.push(body.model_id); }
  if (body.preset_id !== undefined) {
    if (body.preset_id !== null && !checkPresetAccess(db, body.preset_id, user.sub, user.role)) {
      return c.json({ error: 'Preset not available' }, 403);
    }
    updates.push('preset_id=?'); vals.push(body.preset_id);
  }
  if (body.system_prompt_id !== undefined) {
    if (body.system_prompt_id !== null && !checkPromptAccess(db, body.system_prompt_id, user.sub, user.role)) {
      return c.json({ error: 'System prompt not available' }, 403);
    }
    updates.push('system_prompt_id=?'); vals.push(body.system_prompt_id);
  }

  if (updates.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id=?`).run(...(vals as unknown[]));
  }

  const updated = db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  return c.json(serializeConversation(updated));
});

// Delete all (user's own conversations)
conversationsRouter.delete('/', async (c) => {
  const user = c.get('user');
  const db = getDb();
  await deleteAllUploadsForUser(user.sub);
  db.prepare('DELETE FROM conversations WHERE owner_sub=?').run(user.sub);
  return c.body(null, 204);
});

// Delete
conversationsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const db = getDb();
  const id = c.req.param('id');
  await deleteUploadsForConversation(id, user.sub);
  db.prepare('DELETE FROM conversations WHERE id=? AND owner_sub=?').run(id, user.sub);
  return c.body(null, 204);
});

// Duplicate
conversationsRouter.post('/:id/duplicate', (c) => {
  const user = c.get('user');
  const db = getDb();
  const src = db.prepare(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as ConversationRow | undefined;
  if (!src) return c.json({ error: 'Not found' }, 404);

  try {
    const newConv = runTransaction(() => {
      const newId = generateId();
      db.prepare(
        `INSERT INTO conversations (id, owner_sub, title, model_id, preset_id, system_prompt_id, custom_system_prompt, folder_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(newId, user.sub, `${src.title} (copy)`, src.model_id, src.preset_id, src.system_prompt_id, src.custom_system_prompt, src.folder_id);

      copyMessages(db, src.id, newId);

      return db.prepare('SELECT * FROM conversations WHERE id=?').get(newId) as ConversationRow;
    });
    return c.json(serializeConversation(newConv), 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Fork
conversationsRouter.post('/:id/fork', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { message_id: string };
  const db = getDb();
  const src = db.prepare(
    'SELECT * FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as ConversationRow | undefined;
  if (!src) return c.json({ error: 'Not found' }, 404);

  try {
    const newConv = runTransaction(() => {
      const newId = generateId();
      db.prepare(
        `INSERT INTO conversations (id, owner_sub, title, model_id, preset_id, system_prompt_id, custom_system_prompt, forked_from_id, forked_at_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(newId, user.sub, `Fork of: ${src.title}`, src.model_id, src.preset_id, src.system_prompt_id, src.custom_system_prompt, src.id, body.message_id);

      copyMessages(db, src.id, newId, body.message_id);

      return db.prepare('SELECT * FROM conversations WHERE id=?').get(newId) as ConversationRow;
    });
    return c.json(serializeConversation(newConv), 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Messages
conversationsRouter.get('/:id/messages', (c) => {
  const user = c.get('user');
  const db = getDb();
  const conv = db.prepare(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as { id: string } | undefined;
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp'
  ).all(c.req.param('id')) as MessageRow[];
  return c.json(rows.map(serializeMessage));
});

// Edit message
conversationsRouter.patch('/:id/messages/:msgId', async (c) => {
  const user = c.get('user');
  const body = await c.req.json() as { content: string };
  const db = getDb();
  const conv = db.prepare(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as { id: string } | undefined;
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const newContent = JSON.stringify([{ type: 'text', text: body.content }]);
  db.prepare(
    'UPDATE messages SET content=?, content_text=?, edited_at=? WHERE id=? AND conversation_id=?'
  ).run(newContent, body.content, Date.now(), c.req.param('msgId'), c.req.param('id'));

  const row = db.prepare('SELECT * FROM messages WHERE id=?').get(c.req.param('msgId')) as MessageRow;
  return c.json(serializeMessage(row));
});

// Delete message and all after it
conversationsRouter.delete('/:id/messages/:msgId', (c) => {
  const user = c.get('user');
  const db = getDb();
  const conv = db.prepare(
    'SELECT id FROM conversations WHERE id=? AND owner_sub=?'
  ).get(c.req.param('id'), user.sub) as { id: string } | undefined;
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const msg = db.prepare(
    'SELECT timestamp FROM messages WHERE id=?'
  ).get(c.req.param('msgId')) as { timestamp: number } | undefined;
  if (!msg) return c.body(null, 204);

  db.prepare(
    'DELETE FROM messages WHERE conversation_id=? AND timestamp >= ?'
  ).run(c.req.param('id'), msg.timestamp);

  return c.body(null, 204);
});
