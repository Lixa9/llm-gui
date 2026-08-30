import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth.ts';
import { getDb, generateId, runTransaction, safeParseJson } from './db/index.ts';
import { getConfig } from './config.ts';
import { acquireStream, closeStream } from './ratelimit.ts';
import { fetchModels } from './models.ts';
import { logger } from './logger.ts';
import type { MessageContentPart, MessageRow, SessionPayload } from './types.ts';
import { attachUploadsToMessage, cleanupUnreferencedUploads } from './uploads.ts';
import { createBackgroundSseResponse } from './background-sse.ts';
import { cancelGeneration, getGeneration, isActiveGenerationConflict, runGeneration } from './generation-worker.ts';

interface UploadRow {
  sha256: string;
  mime_type: string;
  filename: string;
  size: number;
  extracted_text: string | null;
  file_meta: unknown;
  data: Buffer;
  derived_images: unknown;
}

interface StoredMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

async function resolveContentParts(parts: MessageContentPart[], ownerSub: string): Promise<unknown[]> {
  const resolved: unknown[] = [];
  const db = getDb();
  for (const part of parts) {
    if (part.type === 'text') {
      resolved.push(part);
      continue;
    }
    const url = part.type === 'image_url' ? part.image_url.url : part.file.url;
    if (url.startsWith('data:')) {
      resolved.push(part);
      continue;
    }
    if (!url.startsWith('/api/uploads/')) continue;
    const uploadId = url.split('/').pop();
    if (!uploadId) continue;
    const row = await db.prepare(`
      SELECT sha256, mime_type, filename, size, extracted_text, file_meta, data, derived_images
      FROM uploads WHERE id=? AND owner_sub=?
    `).get<UploadRow>(uploadId, ownerSub);
    if (!row) continue;

    if (part.type === 'image_url') {
      resolved.push({ type: 'image_url', image_url: { url: `data:${row.mime_type};base64,${row.data.toString('base64')}` } });
      continue;
    }

    const meta = safeParseJson<Record<string, unknown>>(row.file_meta, {});
    const derived = safeParseJson<Array<{ data: string; ext: string }>>(row.derived_images, []);
    const isPdf = row.mime_type === 'application/pdf';
    if (isPdf && derived.length > 0) {
      for (let index = 0; index < derived.length; index++) {
        const image = derived[index];
        resolved.push({ type: 'text', text: JSON.stringify({ filename: row.filename, page: index + 1, total_pages: meta.page_count }) });
        resolved.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.data}` } });
      }
      if (Number(meta.page_count) > derived.length) resolved.push({ type: 'text', text: JSON.stringify({ filename: row.filename, note: `Showing first ${derived.length} of ${meta.page_count} pages` }) });
    } else if (derived.length > 0) {
      resolved.push({ type: 'text', text: JSON.stringify({ filename: row.filename, ext: MIME_TO_EXT[row.mime_type] ?? '', size_kb: Math.round(row.size / 1024), content: row.extracted_text ?? '[Text extraction unavailable]' }) });
      for (let index = 0; index < derived.length; index++) {
        const image = derived[index];
        const mime = image.ext === '.png' ? 'image/png' : image.ext === '.gif' ? 'image/gif' : image.ext === '.webp' ? 'image/webp' : 'image/jpeg';
        resolved.push({ type: 'text', text: JSON.stringify({ filename: row.filename, embedded_image: index + 1, of: derived.length }) });
        resolved.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${image.data}` } });
      }
    } else {
      resolved.push({ type: 'text', text: JSON.stringify({ filename: row.filename, ext: MIME_TO_EXT[row.mime_type] ?? '', size_kb: Math.round(row.size / 1024), content: row.extracted_text ?? '[Text extraction unavailable]' }) });
    }
  }
  return resolved;
}

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/epub+zip': '.epub',
};

function contentPartsToText(content: MessageContentPart[]): string {
  return content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text).join('\n');
}

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(1_000_000) }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().min(1).max(30_000_000) }), _filename: z.string().max(255).optional() }),
  z.object({ type: z.literal('file'), file: z.object({ url: z.string().min(1).max(30_000_000) }), _filename: z.string().max(255).optional() }),
]);
const chatRequestSchema = z.object({
  conversation_id: z.string().uuid().nullable().optional(),
  model: z.string().trim().min(1).max(300),
  system_prompt: z.string().max(100_000).optional(),
  assistant_message_id: z.string().uuid().optional(),
  new_user_message: z.object({
    id: z.string().uuid().optional(),
    content: z.array(contentPartSchema).min(1).max(200),
  }),
});
const regenerateRequestSchema = z.object({
  conversation_id: z.string().uuid(),
  assistant_message_id: z.string().uuid(),
  model: z.string().trim().min(1).max(300),
  system_prompt: z.string().max(100_000).optional(),
});

function serializeMessage(row: MessageRow): Omit<MessageRow, 'content'> & { content: MessageContentPart[] } {
  return { ...row, content: safeParseJson<MessageContentPart[]>(row.content, []) };
}

export const relayRouter = new Hono();
relayRouter.use('*', requireAuth);

async function buildOpenaiMessages(
  stored: StoredMessage[],
  latestContent: MessageContentPart[],
  systemPrompt: string | undefined,
  historyMode: 'full' | 'latest_only' | undefined,
  ownerSub: string,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (historyMode !== 'latest_only') {
    for (const message of stored.slice(0, -1)) {
      messages.push({ role: message.role, content: await resolveContentParts(safeParseJson<MessageContentPart[]>(message.content, []), ownerSub) });
    }
  }
  messages.push({ role: 'user', content: await resolveContentParts(latestContent, ownerSub) });
  return messages;
}

interface StreamContext {
  user: SessionPayload;
  convId: string;
  assistantMsgId: string;
  acceptedUser: MessageRow;
  acceptedContent: MessageContentPart[];
}

function createChatResponse(context: StreamContext): Response {
  const { user, convId, assistantMsgId, acceptedUser, acceptedContent } = context;
  return createBackgroundSseResponse({
    type: 'accepted',
    conversation_id: convId,
    assistant_message_id: assistantMsgId,
    user_message: { ...acceptedUser, content: safeParseJson<MessageContentPart[]>(acceptedUser.content, acceptedContent) },
  }, async client => {
    // The durable worker owns the upstream request. This HTTP stream is only an
    // observer and may disappear without affecting the generation job.
    await runGeneration(assistantMsgId, client);
  }, error => {
    logger.error('Detached chat observer failed', { user_sub: user.sub, conv_id: convId, generation_id: assistantMsgId, error: String(error) });
  });
}

function generationSnapshot(
  cfg: ReturnType<typeof getConfig>,
  model: string,
  openaiMessages: unknown[],
  historyMode: 'full' | 'latest_only' | undefined,
  titlePrompt: string,
  isFirstExchange: boolean,
) {
  return {
    model,
    openai_messages: openaiMessages,
    history_mode: historyMode,
    title_prompt: titlePrompt,
    is_first_exchange: isFirstExchange,
    auto_title: cfg.conversation.auto_title,
    auto_title_model: cfg.conversation.auto_title_model,
  };
}

async function findModel(userRole: string, model: string) {
  const allowedModels = await fetchModels(userRole);
  const modelEntry = allowedModels.find(entry => entry.id === model);
  return modelEntry;
}

relayRouter.post('/', async (c) => {
  const user = c.get('user');
  const cfg = getConfig();
  if (!cfg.openai.base_url) return c.json({ error: 'OpenAI-compatible endpoint is not configured.' }, 503);
  const parsedBody = chatRequestSchema.safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'Invalid chat request' }, 400);
  const body = parsedBody.data;
  const modelEntry = await findModel(user.role, body.model);
  if (!modelEntry) return c.json({ error: 'Model not available' }, 400);
  const db = getDb();
  let convId = body.conversation_id;
  if (!convId) {
    convId = generateId();
    await db.prepare('INSERT INTO conversations (id, owner_sub, model_id, custom_system_prompt) VALUES (?, ?, ?, ?)').run(convId, user.sub, body.model, body.system_prompt ?? null);
  } else if (!await db.prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(convId, user.sub)) {
    return c.json({ error: 'Not found' }, 404);
  }
  if (await db.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued', 'running')").get(convId)) {
    return c.json({ error: 'This conversation already has a response in progress' }, 409);
  }

  const existing = await db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY timestamp, id').all<StoredMessage>(convId);
  const userContent = JSON.stringify(body.new_user_message.content);
  const pendingUser: MessageRow = { id: body.new_user_message.id ?? generateId(), conversation_id: convId, role: 'user', content: userContent, content_text: contentPartsToText(body.new_user_message.content), model: null, status: 'done', timestamp: Date.now(), edited_at: null };
  const stored: StoredMessage[] = [...existing, { role: 'user', content: userContent }];
  const openaiMessages = await buildOpenaiMessages(stored, body.new_user_message.content, body.system_prompt, modelEntry.history_mode, user.sub);
  const rl = await acquireStream(user.sub);
  if (!rl.allowed) return c.json({ error: rl.reason }, 429);
  const assistantMsgId = body.assistant_message_id ?? generateId();
  try {
    await runTransaction(async tx => {
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(convId);
      if (await tx.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued', 'running')").get(convId)) {
        throw new Error('ACTIVE_GENERATION');
      }
      await tx.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(pendingUser.id, convId, 'user', pendingUser.content, pendingUser.content_text, 'done', pendingUser.timestamp);
      await attachUploadsToMessage(tx, pendingUser.id, user.sub, userContent);
      await tx.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', '[]', '', ?, 'streaming', ?)`)
        .run(assistantMsgId, convId, body.model, pendingUser.timestamp + 1);
      await tx.prepare(`
        INSERT INTO chat_generations (id, conversation_id, user_message_id, assistant_message_id, owner_sub, request_snapshot, status, rate_lease_id, available_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(assistantMsgId, convId, pendingUser.id, assistantMsgId, user.sub, JSON.stringify(generationSnapshot(cfg, body.model, openaiMessages, modelEntry.history_mode, pendingUser.content_text, existing.filter(message => message.role === 'user').length === 0)), rl.leaseId!, Date.now());
    });
  } catch (error) {
    await closeStream(rl.leaseId!).catch(() => {});
    if ((error as Error).message === 'ACTIVE_GENERATION' || isActiveGenerationConflict(error)) return c.json({ error: 'This conversation already has a response in progress' }, 409);
    throw error;
  }
  return createChatResponse({ user, convId, assistantMsgId, acceptedUser: pendingUser, acceptedContent: body.new_user_message.content });
});

relayRouter.post('/regenerate', async (c) => {
  const user = c.get('user');
  const cfg = getConfig();
  if (!cfg.openai.base_url) return c.json({ error: 'OpenAI-compatible endpoint is not configured.' }, 503);
  const parsedBody = regenerateRequestSchema.safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'Invalid regeneration request' }, 400);
  const body = parsedBody.data;
  const modelEntry = await findModel(user.role, body.model);
  if (!modelEntry) return c.json({ error: 'Model not available' }, 400);
  const db = getDb();
  if (!await db.prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(body.conversation_id, user.sub)) return c.json({ error: 'Not found' }, 404);
  if (await db.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued', 'running')").get(body.conversation_id)) return c.json({ error: 'This conversation already has a response in progress' }, 409);
  const stored = await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY timestamp, id').all<MessageRow>(body.conversation_id);
  const targetIndex = stored.findIndex(message => message.id === body.assistant_message_id && message.role === 'assistant');
  if (targetIndex < 1 || stored[targetIndex - 1].role !== 'user') return c.json({ error: 'Assistant message cannot be regenerated' }, 400);
  const retained = stored.slice(0, targetIndex);
  const userMessage = retained[retained.length - 1];
  const userContent = safeParseJson<MessageContentPart[]>(userMessage.content, []);
  const openaiMessages = await buildOpenaiMessages(retained.map(message => ({ role: message.role as 'user' | 'assistant', content: message.content })), userContent, body.system_prompt, modelEntry.history_mode, user.sub);
  const rl = await acquireStream(user.sub);
  if (!rl.allowed) return c.json({ error: rl.reason }, 429);
  const assistantMsgId = generateId();
  try {
    await runTransaction(async tx => {
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(body.conversation_id);
      if (await tx.prepare("SELECT id FROM chat_generations WHERE conversation_id=? AND status IN ('queued', 'running')").get(body.conversation_id)) {
        throw new Error('ACTIVE_GENERATION');
      }
      const uploadIds = await tx.prepare(`SELECT DISTINCT mu.upload_id FROM message_uploads mu JOIN messages m ON m.id=mu.message_id WHERE m.conversation_id=? AND (m.timestamp, m.id) >= (?, ?)`).all<{ upload_id: string }>(body.conversation_id, stored[targetIndex].timestamp, stored[targetIndex].id);
      await tx.prepare('DELETE FROM messages WHERE conversation_id=? AND (timestamp, id) >= (?, ?)').run(body.conversation_id, stored[targetIndex].timestamp, stored[targetIndex].id);
      await cleanupUnreferencedUploads(tx, user.sub, uploadIds.map(upload => upload.upload_id));
      const assistantTimestamp = Math.max(Date.now(), userMessage.timestamp + 1);
      await tx.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', '[]', '', ?, 'streaming', ?)`)
        .run(assistantMsgId, body.conversation_id, body.model, assistantTimestamp);
      await tx.prepare(`
        INSERT INTO chat_generations (id, conversation_id, user_message_id, assistant_message_id, owner_sub, request_snapshot, status, rate_lease_id, available_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(assistantMsgId, body.conversation_id, userMessage.id, assistantMsgId, user.sub, JSON.stringify(generationSnapshot(cfg, body.model, openaiMessages, modelEntry.history_mode, contentPartsToText(userContent), false)), rl.leaseId!, Date.now());
    });
  } catch (error) {
    await closeStream(rl.leaseId!).catch(() => {});
    if ((error as Error).message === 'ACTIVE_GENERATION' || isActiveGenerationConflict(error)) return c.json({ error: 'This conversation already has a response in progress' }, 409);
    throw error;
  }
  return createChatResponse({ user, convId: body.conversation_id, assistantMsgId, acceptedUser: userMessage, acceptedContent: userContent });
});

relayRouter.get('/generations/:id', async c => {
  const generation = await getGeneration(c.req.param('id'), c.get('user').sub);
  return generation ? c.json(generation) : c.json({ error: 'Not found' }, 404);
});

relayRouter.post('/generations/:id/cancel', async c => {
  const generation = await cancelGeneration(c.req.param('id'), c.get('user').sub);
  return generation ? c.json(generation) : c.json({ error: 'Not found' }, 404);
});
