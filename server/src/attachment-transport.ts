import { z } from 'zod';
import { getConfig } from './config.ts';
import { getDb, safeParseJson, type TxDb } from './db/index.ts';
import type { MessageContentPart, ModelYamlEntry } from './types.ts';

export class InputError extends Error {}
export const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(1_000_000) }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string().regex(/^\/api\/uploads\/[0-9a-f-]{36}$/i) }),
    _filename: z.string().max(255).optional(),
    _mime_type: z.string().max(200).optional(),
    _warning: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('file'),
    file: z.object({ url: z.string().regex(/^\/api\/uploads\/[0-9a-f-]{36}$/i) }),
    _filename: z.string().max(255).optional(),
    _mime_type: z.string().max(200).optional(),
    _warning: z.string().max(2000).optional(),
  }),
]);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
interface UploadRow {
  mime_type: string;
  filename: string;
  size: number;
  extracted_text: string | null;
  file_meta: unknown;
  data: Buffer;
  derived_images: unknown;
}
export async function canonicalizeAttachments(
  parts: MessageContentPart[],
  owner: string,
  db: TxDb,
): Promise<MessageContentPart[]> {
  const result: MessageContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text });
      continue;
    }
    const url = part.type === 'image_url' ? part.image_url.url : part.file.url;
    const row = await db
      .prepare('SELECT filename, mime_type, file_meta FROM uploads WHERE id=? AND owner_sub=? FOR KEY SHARE')
      .get<{ filename: string; mime_type: string; file_meta: unknown }>(
        url.slice('/api/uploads/'.length),
        owner,
      );
    if (!row) throw new InputError('An attachment is missing or no longer available. Upload it again.');
    const meta = safeParseJson<Record<string, unknown>>(row.file_meta, {});
    const fields = {
      _filename: row.filename,
      _mime_type: row.mime_type,
      ...(typeof meta.warning === 'string' ? { _warning: meta.warning } : {}),
    };
    result.push(
      row.mime_type.startsWith('image/')
        ? { type: 'image_url', image_url: { url }, ...fields }
        : { type: 'file', file: { url }, ...fields },
    );
  }
  return result;
}
export async function resolveContentParts(
  parts: MessageContentPart[],
  owner: string,
  model: ModelYamlEntry,
  db: TxDb | ReturnType<typeof getDb> = getDb(),
): Promise<unknown[]> {
  const resolved: unknown[] = [];
  const vision = model.capabilities?.vision === true;
  const detail = model.capabilities?.image_detail ?? 'auto';
  for (const part of parts) {
    if (part.type === 'text') {
      resolved.push({ type: 'text', text: part.text });
      continue;
    }
    const url = part.type === 'image_url' ? part.image_url.url : part.file.url;
    if (url.startsWith('data:') && part.type === 'image_url') {
      // Legacy inline images are read-only; new writes require managed uploads.
      if (!vision || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(url))
        throw new InputError('This historical inline image is invalid or unsupported by this model');
      resolved.push({ type: 'image_url', image_url: { url, detail } });
      continue;
    }
    if (!/^\/api\/uploads\/[0-9a-f-]{36}$/i.test(url))
      throw new InputError('Unsupported attachment reference. Upload the original file again.');
    const row = await db
      .prepare(
        'SELECT mime_type, filename, size, extracted_text, file_meta, data, derived_images FROM uploads WHERE id=? AND owner_sub=?',
      )
      .get<UploadRow>(url.slice('/api/uploads/'.length), owner);
    if (!row)
      throw new InputError('A historical attachment is missing. Restore it or remove the affected message.');
    const meta = safeParseJson<Record<string, unknown>>(row.file_meta, {});
    if (row.mime_type === 'application/pdf' && model.capabilities?.native_pdf) {
      if (!vision) throw new InputError('Native PDF input requires vision support');
      resolved.push({
        type: 'file',
        file: {
          filename: row.filename,
          file_data: `data:application/pdf;base64,${row.data.toString('base64')}`,
        },
      });
      continue;
    }
    const images = safeParseJson<Array<{ data: string; ext: string; label?: string }>>(
      row.derived_images,
      [],
    );
    if (
      meta.processing_status === 'failed' ||
      row.extracted_text?.startsWith('[XLS binary format') ||
      (!row.extracted_text && !images.length && part.type === 'file')
    )
      throw new InputError(
        `${row.filename} has no usable extracted content. Upload it again or select a native PDF model.`,
      );
    if (row.extracted_text)
      resolved.push({
        type: 'text',
        text: JSON.stringify({ filename: row.filename, coverage: meta, content: row.extracted_text }),
      });
    if (images.length) {
      // Never silently discard document visuals when switching to a text model.
      if (!vision) throw new InputError(`${row.filename} includes visual content. Choose a vision model.`);
      for (const [i, image] of images.entries()) {
        const mime = IMAGE_MIME[image.ext.toLowerCase()];
        if (!mime) throw new InputError(`Unsupported derived image in ${row.filename}; upload it again`);
        resolved.push({
          type: 'text',
          text: JSON.stringify({
            filename: row.filename,
            image: image.label ?? i + 1,
            coverage: meta.warning ?? undefined,
          }),
        });
        resolved.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${image.data}`, detail } });
      }
    } else if (part.type === 'image_url') {
      if (!vision || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(row.mime_type))
        throw new InputError(`${row.filename} needs image conversion or a vision model`);
      resolved.push({
        type: 'image_url',
        image_url: { url: `data:${row.mime_type};base64,${row.data.toString('base64')}`, detail },
      });
    }
  }
  return resolved;
}
export function assertRequestBudget(
  messages: unknown[],
  model: ModelYamlEntry,
): { bytes: number; images: number; files: number; text_chars: number } {
  const limits = getConfig().attachments;
  let images = 0,
    files = 0,
    text_chars = 0,
    fileBytes = 0;
  for (const message of messages as Array<{
    content: string | Array<{ type: string; text?: string; file?: { file_data?: string } }>;
  }>) {
    if (typeof message.content === 'string') text_chars += message.content.length;
    else
      for (const part of message.content) {
        if (part.type === 'image_url') images++;
        if (part.type === 'file') {
          files++;
          fileBytes += Buffer.byteLength(part.file?.file_data?.split(',')[1] ?? '', 'base64');
        }
        if (part.type === 'text') text_chars += part.text?.length ?? 0;
      }
  }
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  if (bytes > limits.max_request_bytes)
    throw new InputError(
      `Conversation input exceeds ${Math.round(limits.max_request_bytes / 1024 / 1024)} MB. Start a new conversation or reduce attachments.`,
    );
  if (images > limits.max_images || files > limits.max_files)
    throw new InputError(
      'Conversation exceeds the configured image/file limit. Reduce attachments or start a new conversation.',
    );
  if (fileBytes >= 50 * 1024 * 1024) throw new InputError('Native PDF inputs must total less than 50 MB');
  if (
    text_chars > Math.min(limits.max_text_chars, model.capabilities?.max_text_chars ?? limits.max_text_chars)
  )
    throw new InputError(
      'Conversation exceeds the configured text context budget. Reduce the document size or start a new conversation.',
    );
  return { bytes, images, files, text_chars };
}
