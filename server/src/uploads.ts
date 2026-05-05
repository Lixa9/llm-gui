import { Hono } from 'hono';
import { requireAuth } from './auth';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { logger } from './logger';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/data/uploads';

export const uploadsRouter = new Hono();
uploadsRouter.use('*', requireAuth);

uploadsRouter.post('/', async (c) => {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file' }, 400);
  const bytes = await file.arrayBuffer();
  const buf = new Uint8Array(bytes);

  // SHA-256 content addressing
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const ext = extname(file.name) || (file.type ? `.${file.type.split('/')[1]}` : '');
  const filename = `${hashHex}${ext}`;
  const filepath = join(UPLOAD_DIR, filename);

  if (!existsSync(filepath)) {
    writeFileSync(filepath, buf);
    logger.info('File uploaded', { filename, size: buf.length, type: file.type });
  }

  return c.json({ url: `/uploads/${filename}` }, 201);
});

// Auth-gated static serving for uploads
export async function serveUpload(filename: string): Promise<Response> {
  const filepath = join(UPLOAD_DIR, filename);
  if (!existsSync(filepath)) {
    return new Response('Not found', { status: 404 });
  }

  const buf = readFileSync(filepath);
  const ext = extname(filename).slice(1).toLowerCase();
  const mime: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html',
    yaml: 'text/yaml', yml: 'text/yaml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
  };

  return new Response(buf, {
    headers: {
      'Content-Type': mime[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
