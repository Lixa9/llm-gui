import { z } from 'zod';
import { getConfig } from './config.ts';
import { getDb, safeParseJson, type TxDb } from './db/index.ts';
import type { MessageContentPart, ModelYamlEntry } from './types.ts';
import type { AttachmentBlock } from './processing.ts';

export class InputError extends Error {}
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' | 'low' | 'high' } }
  | { type: 'file'; file: { filename: string; file_data: string } };
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
const blockLocation = {
  part: z.string().max(10000).optional(),
  entry: z.string().max(10000).optional(),
  notices: z.array(z.string().max(10000)).max(50).optional(),
};
const blockSchema = z.union([
  z.object({type:z.literal('text'),text:z.string().max(1_000_000),format:z.enum(['csv','jsonl']).optional(),...blockLocation}),
  z.object({type:z.literal('image'),image_index:z.number().int().nonnegative(),...blockLocation}),
]);

export function attachmentText(filename: string, text: string, location: {
  entry?: string; part?: string; notices?: string[];
} = {}): string {
  const lines = [`Attachment: ${JSON.stringify(filename)}`];
  if (location.entry !== undefined) lines.push(`Entry: ${JSON.stringify(location.entry)}`);
  if (location.part !== undefined) lines.push(`Part: ${JSON.stringify(location.part)}`);
  for (const notice of new Set(location.notices ?? [])) lines.push(`Notice: ${JSON.stringify(notice)}`);
  return `${lines.join('\n')}\n\n${text}`;
}

/** Plain messages are strings; attached messages have user text first. */
export async function resolveMessageContent(
  parts: MessageContentPart[], owner: string, model: ModelYamlEntry,
  db: TxDb | ReturnType<typeof getDb> = getDb(), role = 'user',
): Promise<string | ChatContentPart[]> {
  const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
  const attachments = parts.filter(part => part.type !== 'text');
  if (!attachments.length) return text;
  if (role !== 'user') throw new InputError('Only user messages can contain attachments');
  return [{type:'text',text},...await resolveContentParts(attachments,owner,model,db)];
}

export async function resolveContentParts(
  parts: MessageContentPart[],
  owner: string,
  model: ModelYamlEntry,
  db: TxDb | ReturnType<typeof getDb> = getDb(),
): Promise<ChatContentPart[]> {
  const resolved: ChatContentPart[] = [];
  const vision = model.capabilities?.vision === true;
  const detail = model.capabilities?.image_detail ?? 'auto';
  for (const part of parts) {
    if (part.type === 'text') {
      resolved.push({type:'text',text:part.text});
      continue;
    }
    const url = part.type === 'image_url' ? part.image_url.url : part.file.url;
    if (url.startsWith('data:') && part.type === 'image_url') {
      // Legacy inline images are read-only; their missing filename is explicit.
      if (!vision || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(url))
        throw new InputError('This historical inline image is invalid or unsupported by this model');
      resolved.push({type:'text',text:attachmentText(part._filename ?? 'image','')});
      resolved.push({type:'image_url',image_url:{url,detail}});
      continue;
    }
    if (!/^\/api\/uploads\/[0-9a-f-]{36}$/i.test(url))
      throw new InputError('Unsupported attachment reference. Upload the original file again.');
    const row = await db.prepare(
      'SELECT mime_type, filename, size, extracted_text, file_meta, data, derived_images FROM uploads WHERE id=? AND owner_sub=?',
    ).get<UploadRow>(url.slice('/api/uploads/'.length),owner);
    if (!row) throw new InputError('A historical attachment is missing. Restore it or remove the affected message.');
    const meta = safeParseJson<Record<string, unknown>>(row.file_meta,{});
    if (row.mime_type === 'application/pdf' && model.capabilities?.native_pdf) {
      if (!vision) throw new InputError('Native PDF input requires vision support');
      resolved.push({type:'file',file:{filename:row.filename,file_data:`data:application/pdf;base64,${row.data.toString('base64')}`}});
      continue;
    }
    const images = safeParseJson<Array<{data:string;ext:string;label?:string}>>(row.derived_images,[]);
    if (meta.processing_status === 'failed' || meta.processing_status === 'native_only' || row.extracted_text?.startsWith('[XLS binary format'))
      throw new InputError(`${row.filename} has no usable extracted content. Upload it again or select a native PDF model.`);
    let blocks: AttachmentBlock[];
    if (meta.content_blocks !== undefined) {
      const parsed = z.array(blockSchema).max(10000).safeParse(meta.content_blocks);
      if (!parsed.success) throw new InputError(`${row.filename} has invalid extracted content. Upload it again.`);
      blocks = parsed.data;
    } else {
      // Older uploads keep their existing extraction; do not guess boundaries
      // by parsing markers that could also occur in the document's own text.
      blocks = [
        ...(row.extracted_text !== null ? [{type:'text' as const,text:row.extracted_text}] : []),
        ...images.map((image,image_index)=>({type:'image' as const,image_index,part:image.label ?? (images.length > 1 ? `Image ${image_index + 1}` : undefined)})),
      ];
      if (!images.length && part.type === 'image_url') {
        if (!['image/jpeg','image/png','image/gif','image/webp'].includes(row.mime_type))
          throw new InputError(`${row.filename} needs image conversion or a vision model`);
        const ext = Object.entries(IMAGE_MIME).find(([,mime])=>mime===row.mime_type)![0];
        images.push({data:row.data.toString('base64'),ext});
        blocks.push({type:'image',image_index:0});
      }
    }
    if (!blocks.length) throw new InputError(`${row.filename} has no usable extracted content. Upload it again.`);
    if (images.length && !vision) throw new InputError(`${row.filename} includes visual content. Choose a vision model.`);
    const references = blocks.filter(block=>block.type==='image').map(block=>block.image_index);
    if (references.some(index=>index>=images.length) || images.some((_,index)=>!references.includes(index)))
      throw new InputError(`${row.filename} has inconsistent image references. Upload it again.`);
    const warning = typeof meta.warning === 'string' && meta.warning ? meta.warning : meta.truncated ? 'Some extracted text was omitted at the document text limit.' : undefined;
    let previous: AttachmentBlock | undefined;
    let previousNotices: string[] = [];
    for (const [index,block] of blocks.entries()) {
      const notices = [...(block.notices ?? []),...(index === 0 && warning ? [warning] : [])];
      if (block.type === 'text') {
        resolved.push({type:'text',text:attachmentText(row.filename,block.text,{...block,notices})});
      } else {
        const image = images[block.image_index];
        const mime = IMAGE_MIME[image.ext.toLowerCase()];
        if (!mime || !/^[A-Za-z0-9+/]+=*$/.test(image.data))
          throw new InputError(`Unsupported derived image in ${row.filename}; upload it again`);
        if (previous?.type !== 'text' || previous.part !== block.part || previous.entry !== block.entry || notices.some(notice => !previousNotices.includes(notice)))
          resolved.push({type:'text',text:attachmentText(row.filename,'',{...block,notices})});
        resolved.push({type:'image_url',image_url:{url:`data:${mime};base64,${image.data}`,detail}});
      }
      previous = block;
      previousNotices = notices;
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
