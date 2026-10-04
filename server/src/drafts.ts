import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth.ts';
import { getDb, safeParseJson } from './db/index.ts';
import { publicFileMeta } from './content-blocks.ts';

export const draftsRouter = new Hono();
draftsRouter.use('*', requireAuth);
const draftSchema = z.object({
  text: z.string().max(1000000),
  attachments: z.array(z.object({ id: z.string().uuid() })).max(20),
});
draftsRouter.use('/:key', async (c, next) => {
  const key = c.req.param('key');
  if (key !== 'new' && !z.string().uuid().safeParse(key).success)
    return c.json({ error: 'Invalid conversation key' }, 400);
  if (
    key !== 'new' &&
    !(await getDb()
      .prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?')
      .get(key, c.get('user').sub))
  )
    return c.json({ error: 'Not found' }, 404);
  return next();
});
draftsRouter.get('/:key', async (c) => {
  const row = await getDb()
    .prepare('SELECT draft FROM conversation_drafts WHERE user_sub=? AND conversation_key=?')
    .get<{ draft: unknown }>(c.get('user').sub, c.req.param('key'));
  const draft = safeParseJson<{ text: string; attachments: Array<{ id: string }> }>(row?.draft, {
    text: '',
    attachments: [],
  });
  const attachments = [];
  for (const { id } of draft.attachments) {
    const upload = await getDb()
      .prepare('SELECT id,filename,mime_type,size,file_meta FROM uploads WHERE id=? AND owner_sub=?')
      .get<{ id: string; filename: string; mime_type: string; size: number; file_meta: unknown }>(
        id,
        c.get('user').sub,
      );
    if (upload) {
      const coverage = publicFileMeta(safeParseJson<Record<string, unknown>>(upload.file_meta, {}));
      attachments.push({
        id: upload.id,
        filename: upload.filename,
        mime_type: upload.mime_type,
        size: upload.size,
        url: `/api/uploads/${id}`,
        kind: upload.mime_type.startsWith('image/') ? 'image' : 'file',
        processing_status: coverage.processing_status ?? 'ready',
        coverage,
        ...(typeof coverage.warning === 'string' ? { warning: coverage.warning } : {}),
      });
    }
  }
  return c.json({ text: draft.text, attachments });
});
draftsRouter.put('/:key', async (c) => {
  const parsed = draftSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid draft' }, 400);
  const owner = c.get('user').sub,
    key = c.req.param('key');
  const ok = await getDb().withAdvisoryLock(`draft:${owner}:${key}`, async (db) => {
    if (key !== 'new') {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(key);
      if (!(await db.prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(key, owner)))
        return false;
    }
    const ids = [...new Set(parsed.data.attachments.map((a) => a.id))];
    const uploads = ids.length
      ? await db
          .prepare('SELECT id FROM uploads WHERE owner_sub=? AND id=ANY(?::uuid[]) FOR KEY SHARE')
          .all(owner, ids)
      : [];
    if (uploads.length !== ids.length) return false;
    await db
      .prepare(
        `INSERT INTO conversation_drafts (user_sub,conversation_key,draft,updated_at) VALUES (?,?,?::jsonb,?)
      ON CONFLICT(user_sub,conversation_key) DO UPDATE SET draft=excluded.draft,updated_at=excluded.updated_at`,
      )
      .run(owner, key, JSON.stringify(parsed.data), Date.now());
    await db.prepare('DELETE FROM draft_uploads WHERE user_sub=? AND conversation_key=?').run(owner, key);
    for (const id of ids)
      await db
        .prepare('INSERT INTO draft_uploads (user_sub,conversation_key,upload_id) VALUES (?,?,?)')
        .run(owner, key, id);
    return true;
  });
  return ok ? c.body(null, 204) : c.json({ error: 'Draft attachment is unavailable' }, 400);
});
