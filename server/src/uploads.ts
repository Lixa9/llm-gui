import { requireAuth } from './auth.ts';
import { Hono } from 'hono';
import { getDb, generateId, safeParseJson } from './db/index.ts';
import type { TxDb } from './db/index.ts';
import { checkRateLimit } from './ratelimit.ts';
import { getConfig } from './config.ts';
import { logger } from './logger.ts';
import { FILE_FORMATS, recognizeFormat } from './formats.ts';
import { processUpload } from './processing.ts';
import { publicFileMeta } from './content-blocks.ts';

export const uploadsRouter = new Hono();
uploadsRouter.use('*', requireAuth);

export const ALLOWED_IMAGE_TYPES = new Set(FILE_FORMATS.filter(f => f.kind === 'image').map(f => f.mime));
export const ALLOWED_TEXT_TYPES = new Set(FILE_FORMATS.filter(f => f.kind !== 'image').map(f => f.mime));
export const MIME_TO_EXT = Object.fromEntries(FILE_FORMATS.map(f => [f.mime, '.' + f.extensions[0]]));
const IMAGE_MAX_SIZE = 20 * 1024 * 1024;
const TEXT_MAX_SIZE = 50 * 1024 * 1024;

async function storageUsage(ownerSub: string, db: ReturnType<typeof getDb> | TxDb): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(
      octet_length(data) +
      COALESCE(octet_length(extracted_text), 0) +
      COALESCE(octet_length(derived_images::text), 0) +
      COALESCE(octet_length(file_meta::text), 0)
    ), 0)::bigint AS bytes
    FROM uploads WHERE owner_sub=?
  `).get<{ bytes: number }>(ownerSub);
  return row?.bytes ?? 0;
}

export function classifyMime(mime: string) {
  return { isPdf: mime === 'application/pdf', isDocx: mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', isOdt: mime === 'application/vnd.oasis.opendocument.text', isEpub: mime === 'application/epub+zip' };
}

interface DerivedImage { data: string; ext: string; }

uploadsRouter.post('/', async (c) => {
  const user = c.get('user');
  const rl = await checkRateLimit(user.sub);
  if (!rl.allowed) return c.json({ error: rl.reason }, 429);
  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ error: 'Expected multipart/form-data' }, 400); }
  const file = formData.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'No file provided' }, 400);
  let format;
  try { format = recognizeFormat(file.name, file.type); } catch { return c.json({ error: 'Unsupported file format.' }, 415); }
  const mime = format.mime;
  const isImage = format.kind === 'image';
  const maxSize = isImage ? IMAGE_MAX_SIZE : TEXT_MAX_SIZE;
  if (file.size > maxSize) return c.json({ error: `File too large (max ${isImage ? '20' : '50'} MB)` }, 413);

  const quota = getConfig().storage.quota;
  if (quota > 0 && await storageUsage(user.sub, getDb()) + file.size > quota) {
    return c.json({ error: 'Storage quota exceeded' }, 507);
  }

  const bytes = await file.arrayBuffer();
  const buf = Buffer.from(bytes);
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  let extractedText: string | null = null;
  let fileMeta: Record<string, unknown> = {};
  let derivedImages: DerivedImage[] = [];
  let warning: string | undefined;

  try {
    const result = await processUpload(buf, mime, file.name);
    extractedText = result.text;
    fileMeta = {...result.meta,warning:result.warning ?? null};
    derivedImages = result.images;
    warning = result.warning;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document processing failed';
    logger.warn('Upload processing failed', { user_sub: user.sub, mime_type: mime });
    // No successful-looking upload with a placeholder. Originals remain on the
    // user's device; corrupt/unsupported conversions do not consume storage.
    return c.json({ error: message }, message.includes('busy') ? 429 : 422);
  }

  const storedBytes = buf.byteLength +
    Buffer.byteLength(extractedText ?? '', 'utf8') +
    Buffer.byteLength(JSON.stringify(derivedImages), 'utf8') +
    Buffer.byteLength(JSON.stringify(fileMeta), 'utf8');
  const id = await getDb().withAdvisoryLock(`storage-quota:${user.sub}`, async db => {
    if (quota > 0 && await storageUsage(user.sub, db) + storedBytes > quota) return null;
    const uploadId = generateId();
    await db.prepare(`
      INSERT INTO uploads (id, owner_sub, sha256, filename, mime_type, size, extracted_text, file_meta, data, derived_images)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb)
    `).run(uploadId, user.sub, sha256, file.name.slice(0, 255), mime, file.size, extractedText, JSON.stringify(fileMeta), buf, JSON.stringify(derivedImages));
    return uploadId;
  });
  if (!id) return c.json({ error: 'Storage quota exceeded' }, 507);
  logger.info('Upload stored', { user_sub: user.sub, id, mime_type: mime, size: file.size });
  return c.json({ id, filename: file.name.slice(0,255), mime_type: mime, size: file.size, url: `/api/uploads/${id}`, kind: isImage ? 'image' : 'file', processing_status: fileMeta.processing_status ?? 'ready', coverage: publicFileMeta(fileMeta), ...(warning ? { warning } : {}) }, 201);
});

uploadsRouter.get('/formats', c => c.json(FILE_FORMATS));
uploadsRouter.get('/:id/metadata', async c => {
  const row = await getDb().prepare('SELECT id, filename, mime_type, size, file_meta FROM uploads WHERE id=? AND owner_sub=?').get(c.req.param('id'), c.get('user').sub);
  if (!row) return c.json({ error: 'Not found' }, 404);
  const coverage = publicFileMeta(safeParseJson<Record<string, unknown>>(row.file_meta, {}));
  return c.json({ ...row, file_meta: coverage, coverage });
});
uploadsRouter.get('/:id/preview', async c => {
  const row = await getDb().prepare('SELECT derived_images, data, mime_type FROM uploads WHERE id=? AND owner_sub=?').get<{ derived_images: unknown; data: Buffer; mime_type: string }>(c.req.param('id'), c.get('user').sub);
  const images = safeParseJson<DerivedImage[]>(row?.derived_images, []);
  const image = images[0];
  if (!image) {
    if (row && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(row.mime_type)) {
      return new Response(new Uint8Array(row.data), { headers: { 'Content-Type': row.mime_type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
    return c.json({ error: 'Preview unavailable' }, 404);
  }
  return new Response(new Uint8Array(Buffer.from(image.data, 'base64')), { headers: { 'Content-Type': image.ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
});

uploadsRouter.get('/:id', async (c) => {
  const row = await getDb().prepare('SELECT owner_sub, mime_type, filename, data FROM uploads WHERE id=?').get<{ owner_sub: string; mime_type: string; filename: string; data: Buffer }>(c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.owner_sub !== c.get('user').sub) return c.json({ error: 'Forbidden' }, 403);
  return new Response(new Uint8Array(row.data), {
    headers: {
      'Content-Type': row.mime_type,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `${['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(row.mime_type) ? 'inline' : 'attachment'}; filename="${row.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

function extractUploadIds(content: string): string[] {
  const parts = safeParseJson<Array<{ type: string; image_url?: { url: string }; file?: { url: string } }>>(content, []);
  return [...new Set(parts.flatMap(part => {
    const url = part.type === 'image_url' ? part.image_url?.url : part.type === 'file' ? part.file?.url : undefined;
    const id = url?.startsWith('/api/uploads/') ? url.slice('/api/uploads/'.length).split('/')[0] : undefined;
    return id && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [];
  }))];
}

type UploadDb = ReturnType<typeof getDb> | TxDb;

export async function attachUploadsToMessage(db: UploadDb, messageId: string, ownerSub: string, content: string): Promise<void> {
  const ids = extractUploadIds(content);
  if (ids.length === 0) return;
  const rows = await db.prepare('SELECT id FROM uploads WHERE owner_sub=? AND id = ANY(?::uuid[])').all<{ id: string }>(ownerSub, ids);
  if (rows.length !== ids.length) throw new Error('Message references an unavailable upload');
  for (const id of ids) {
    await db.prepare('INSERT INTO message_uploads (message_id, upload_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(messageId, id);
  }
}

export async function uploadIdsForConversation(db: UploadDb, conversationId: string): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT mu.upload_id
    FROM message_uploads mu JOIN messages m ON m.id=mu.message_id
    WHERE m.conversation_id=?
  `).all<{ upload_id: string }>(conversationId);
  return rows.map(row => row.upload_id);
}

export async function cleanupUnreferencedUploads(db: UploadDb, ownerSub: string, ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  await db.prepare(`
    DELETE FROM uploads u
    WHERE u.owner_sub=? AND u.id = ANY(?::uuid[])
      AND NOT EXISTS (SELECT 1 FROM message_uploads mu WHERE mu.upload_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM draft_uploads du WHERE du.upload_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM generation_uploads gu WHERE gu.upload_id=u.id)
  `).run(ownerSub, uniqueIds);
}

export async function deleteAllUploadsForUser(ownerSub: string): Promise<void> {
  await getDb().prepare('DELETE FROM uploads WHERE owner_sub=?').run(ownerSub);
}

export async function purgeOrphanUploads(olderThan = Date.now() - 24 * 60 * 60 * 1000): Promise<void> {
  await getDb().prepare(`
    DELETE FROM uploads u
    WHERE u.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM message_uploads mu WHERE mu.upload_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM draft_uploads du WHERE du.upload_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM generation_uploads gu WHERE gu.upload_id=u.id)
  `).run(olderThan);
}

uploadsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const attached = await getDb().prepare('SELECT 1 FROM message_uploads WHERE upload_id=? UNION ALL SELECT 1 FROM draft_uploads WHERE upload_id=? UNION ALL SELECT 1 FROM generation_uploads WHERE upload_id=? LIMIT 1').get(id,id,id);
  if (attached) return c.json({ error: 'Upload is attached to a message' }, 409);
  await getDb().prepare('DELETE FROM uploads WHERE id=? AND owner_sub=?').run(id, user.sub);
  return c.body(null, 204);
});
