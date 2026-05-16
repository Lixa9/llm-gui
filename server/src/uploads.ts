import { Hono } from 'hono';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { checkRateLimit } from './ratelimit';
import { logger } from './logger';
import { extractText, renderPdfPages, extractDocImages } from './extract';

export const uploadsRouter = new Hono();
uploadsRouter.use('*', requireAuth);

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const ALLOWED_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'text/xml',
  'application/json',
  'application/yaml',
  'text/yaml',
  'application/xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/epub+zip',
]);

export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/json': '.json',
  'application/yaml': '.yaml',
  'text/yaml': '.yaml',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/plain': '.txt',
  'application/epub+zip': '.epub',
};

const IMAGE_MAX_SIZE = 20 * 1024 * 1024;
const TEXT_MAX_SIZE = 50 * 1024 * 1024;

export function classifyMime(mime: string) {
  return {
    isPdf: mime === 'application/pdf',
    isDocx: mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    isOdt: mime === 'application/vnd.oasis.opendocument.text',
    isEpub: mime === 'application/epub+zip',
  };
}

export function getUploadsDir(): string {
  const cfg = getConfig();
  return join(dirname(cfg.database.path), 'uploads');
}

uploadsRouter.post('/', async (c) => {
  const user = c.get('user');

  const rl = checkRateLimit(user.sub);
  if (!rl.allowed) return c.json({ error: rl.reason }, 429);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const isImage = ALLOWED_IMAGE_TYPES.has(file.type);
  const isTextFile = ALLOWED_TEXT_TYPES.has(file.type);

  if (!isImage && !isTextFile) {
    return c.json({ error: 'Unsupported file type.' }, 415);
  }

  const maxSize = isImage ? IMAGE_MAX_SIZE : TEXT_MAX_SIZE;
  if (file.size > maxSize) {
    return c.json({ error: `File too large (max ${isImage ? '20' : '50'} MB)` }, 413);
  }

  const bytes = await file.arrayBuffer();
  const buf = Buffer.from(bytes);

  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Buffer.from(hashBuf).toString('hex');

  const ext = MIME_TO_EXT[file.type] ?? '';
  const uploadsDir = getUploadsDir();
  mkdirSync(uploadsDir, { recursive: true });

  const filePath = join(uploadsDir, `${sha256}${ext}`);
  if (!existsSync(filePath)) {
    await writeFile(filePath, buf);
  }

  let extracted_text: string | null = null;
  let file_meta: string | null = null;
  let warning: string | undefined;

  if (isTextFile) {
    const { isPdf, isDocx, isOdt, isEpub } = classifyMime(file.type);

    try {
      if (isPdf) {
        const res = await renderPdfPages(buf, sha256, uploadsDir);
        file_meta = JSON.stringify({ format: 'pdf', page_count: res.page_count, served_pages: res.served });
        warning = res.warning;
      } else if (isDocx || isOdt || isEpub) {
        const [textRes, imgRes] = await Promise.all([
          extractText(buf, file.type),
          extractDocImages(buf, sha256, uploadsDir, isDocx ? 'docx' : isOdt ? 'odt' : 'epub'),
        ]);
        extracted_text = textRes.text;
        const meta = {
          ...textRes.meta,
          embedded_image_count: imgRes.count,
          served_image_count: imgRes.served,
        };
        file_meta = JSON.stringify(meta);
        warning = textRes.warning ?? imgRes.warning;
      } else {
        const res = await extractText(buf, file.type);
        extracted_text = res.text;
        file_meta = JSON.stringify(res.meta);
        warning = res.warning;
      }
    } catch (err) {
      logger.warn('text extraction failed', { filename: file.name, error: (err as Error).message });
    }
  }

  const db = getDb();
  const id = generateId();
  db.prepare(
    'INSERT INTO uploads (id, owner_sub, sha256, filename, mime_type, size, extracted_text, file_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, user.sub, sha256, file.name, file.type, file.size, extracted_text, file_meta);

  logger.info('upload', { user_sub: user.sub, id, filename: file.name, mime_type: file.type, size: file.size });

  return c.json({
    id,
    filename: file.name,
    mime_type: file.type,
    size: file.size,
    url: `/api/uploads/${id}`,
    ...(warning !== undefined && { warning }),
  }, 201);
});

uploadsRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const db = getDb();
  const row = db.prepare(
    'SELECT owner_sub, sha256, mime_type, filename FROM uploads WHERE id=?'
  ).get(id) as { owner_sub: string; sha256: string; mime_type: string; filename: string } | undefined;

  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.owner_sub !== user.sub) return c.json({ error: 'Forbidden' }, 403);

  const ext = MIME_TO_EXT[row.mime_type] ?? '';
  const filePath = join(getUploadsDir(), `${row.sha256}${ext}`);

  if (!existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404);

  const buffer = await readFile(filePath);
  return new Response(buffer, {
    headers: {
      'Content-Type': row.mime_type,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="${row.filename.replace(/[\x00-\x1f\x7f"\\]/g, '_')}"`,
    },
  });
});
