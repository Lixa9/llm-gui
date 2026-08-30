import { requireAuth } from './auth.ts';
import { Hono } from 'hono';
import { getDb, generateId, safeParseJson } from './db/index.ts';
import type { TxDb } from './db/index.ts';
import { checkRateLimit } from './ratelimit.ts';
import { getConfig } from './config.ts';
import { logger } from './logger.ts';
import { extractText, renderPdfPages, extractDocImages } from './extract.ts';

export const uploadsRouter = new Hono();
uploadsRouter.use('*', requireAuth);

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const ALLOWED_TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/html', 'text/xml', 'application/json', 'application/yaml', 'text/yaml', 'application/xml',
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'application/epub+zip',
]);
export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/vnd.ms-excel': '.xls', 'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'text/html': '.html', 'text/markdown': '.md', 'text/csv': '.csv', 'text/tab-separated-values': '.tsv', 'application/json': '.json',
  'application/yaml': '.yaml', 'text/yaml': '.yaml', 'application/xml': '.xml', 'text/xml': '.xml', 'text/plain': '.txt', 'application/epub+zip': '.epub',
};
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
  const isImage = ALLOWED_IMAGE_TYPES.has(file.type);
  const isTextFile = ALLOWED_TEXT_TYPES.has(file.type);
  if (!isImage && !isTextFile) return c.json({ error: 'Unsupported file type.' }, 415);
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

  if (isTextFile) {
    const { isPdf, isDocx, isOdt, isEpub } = classifyMime(file.type);
    try {
      if (isPdf) {
        const result = await renderPdfPages(buf);
        fileMeta = { format: 'pdf', page_count: result.page_count, served_pages: result.served };
        derivedImages = result.pages.map(data => ({ data, ext: '.jpg' }));
        warning = result.warning;
      } else if (isDocx || isOdt || isEpub) {
        const [textResult, imageResult] = await Promise.all([
          extractText(buf, file.type),
          extractDocImages(buf, isDocx ? 'docx' : isOdt ? 'odt' : 'epub'),
        ]);
        extractedText = textResult.text;
        fileMeta = { ...textResult.meta, embedded_image_count: imageResult.count, served_image_count: imageResult.served };
        derivedImages = imageResult.images;
        warning = textResult.warning ?? imageResult.warning;
      } else {
        const result = await extractText(buf, file.type);
        extractedText = result.text;
        fileMeta = { ...result.meta };
        warning = result.warning;
      }
    } catch (error) {
      logger.warn('Text extraction failed', { error: String(error) });
    }
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
    `).run(uploadId, user.sub, sha256, file.name.slice(0, 255), file.type, file.size, extractedText, JSON.stringify(fileMeta), buf, JSON.stringify(derivedImages));
    return uploadId;
  });
  if (!id) return c.json({ error: 'Storage quota exceeded' }, 507);
  logger.info('Upload stored', { user_sub: user.sub, id, mime_type: file.type, size: file.size });
  return c.json({ id, filename: file.name, mime_type: file.type, size: file.size, url: `/api/uploads/${id}`, ...(warning ? { warning } : {}) }, 201);
});

uploadsRouter.get('/:id', async (c) => {
  const row = await getDb().prepare('SELECT owner_sub, mime_type, filename, data FROM uploads WHERE id=?').get<{ owner_sub: string; mime_type: string; filename: string; data: Buffer }>(c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.owner_sub !== c.get('user').sub) return c.json({ error: 'Forbidden' }, 403);
  return new Response(new Uint8Array(row.data), {
    headers: {
      'Content-Type': row.mime_type,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `${ALLOWED_IMAGE_TYPES.has(row.mime_type) ? 'inline' : 'attachment'}; filename="${row.filename.replace(/[\x00-\x1f\x7f"\\]/g, '_')}"`,
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
  `).run(olderThan);
}

uploadsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const attached = await getDb().prepare('SELECT 1 FROM message_uploads WHERE upload_id=? LIMIT 1').get(id);
  if (attached) return c.json({ error: 'Upload is attached to a message' }, 409);
  await getDb().prepare('DELETE FROM uploads WHERE id=? AND owner_sub=?').run(id, user.sub);
  return c.body(null, 204);
});
