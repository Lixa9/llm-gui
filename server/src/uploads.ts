import { Hono } from 'hono';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { checkRateLimit } from './ratelimit';
import { logger } from './logger';

export const uploadsRouter = new Hono();
uploadsRouter.use('*', requireAuth);

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

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

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return c.json({ error: `Unsupported file type. Allowed: jpeg, png, gif, webp` }, 415);
  }

  if (file.size > MAX_SIZE) {
    return c.json({ error: 'File too large (max 20 MB)' }, 413);
  }

  const bytes = await file.arrayBuffer();

  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Buffer.from(hashBuf).toString('hex');

  const ext = MIME_TO_EXT[file.type] ?? '';
  const uploadsDir = getUploadsDir();
  mkdirSync(uploadsDir, { recursive: true });

  const filePath = join(uploadsDir, `${sha256}${ext}`);
  if (!existsSync(filePath)) {
    await writeFile(filePath, Buffer.from(bytes));
  }

  const db = getDb();
  const id = generateId();
  db.prepare(
    'INSERT INTO uploads (id, owner_sub, sha256, filename, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, user.sub, sha256, file.name, file.type, file.size);

  logger.info('upload', { user_sub: user.sub, id, filename: file.name, mime_type: file.type, size: file.size });

  return c.json({ id, filename: file.name, mime_type: file.type, size: file.size, url: `/api/uploads/${id}` }, 201);
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
