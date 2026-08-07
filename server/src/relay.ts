import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { getDb, generateId, safeParseJson } from './db/index';
import { getConfig } from './config';
import { acquireStream, closeStream } from './ratelimit';
import { fetchModels } from './models';
import { logger } from './logger';
import type { MessageContentPart, MessageRow } from './types';

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
  role: 'user' | 'assistant';
  content: string;
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
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

function serializeMessage(row: MessageRow): Omit<MessageRow, 'content'> & { content: MessageContentPart[] } {
  return { ...row, content: safeParseJson<MessageContentPart[]>(row.content, []) };
}

export const relayRouter = new Hono();
relayRouter.use('*', requireAuth);

relayRouter.post('/', async (c) => {
  const user = c.get('user');
  const cfg = getConfig();
  if (!cfg.openai.base_url) return c.json({ error: 'OpenAI-compatible endpoint is not configured.' }, 503);
  const parsedBody = chatRequestSchema.safeParse(await c.req.json());
  if (!parsedBody.success) return c.json({ error: 'Invalid chat request' }, 400);
  const body = parsedBody.data as {
    conversation_id?: string | null;
    model: string;
    system_prompt?: string;
    assistant_message_id?: string;
    new_user_message: { id?: string; content: MessageContentPart[] };
  };
  const allowedModels = await fetchModels(user.role);
  const modelEntry = allowedModels.find(model => model.id === body.model);
  if (!modelEntry) return c.json({ error: 'Model not available' }, 400);

  const db = getDb();
  let convId = body.conversation_id;
  if (!convId) {
    convId = generateId();
    await db.prepare('INSERT INTO conversations (id, owner_sub, model_id, custom_system_prompt) VALUES (?, ?, ?, ?)').run(convId, user.sub, body.model, body.system_prompt ?? null);
  } else if (!await db.prepare('SELECT id FROM conversations WHERE id=? AND owner_sub=?').get(convId, user.sub)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rl = await acquireStream(user.sub);
  if (!rl.allowed) return c.json({ error: rl.reason }, 429);
  const leaseId = rl.leaseId!;
  const userMsgId = body.new_user_message.id ?? generateId();
  const assistantMsgId = body.assistant_message_id ?? generateId();
  const userTimestamp = Date.now();
  const userContent = JSON.stringify(body.new_user_message.content);
  const userText = contentPartsToText(body.new_user_message.content);
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userMsgId, convId, 'user', userContent, userText, 'done', userTimestamp);

  const stored = await db.prepare(`SELECT role, content FROM messages WHERE conversation_id=? ORDER BY timestamp, id`).all<StoredMessage>(convId);
  const history = stored.slice(0, -1).map(message => ({ role: message.role, content: safeParseJson<MessageContentPart[]>(message.content, []) }));
  const openaiMessages: unknown[] = [];
  if (body.system_prompt) openaiMessages.push({ role: 'system', content: body.system_prompt });
  if (modelEntry.history_mode !== 'latest_only') {
    for (const message of history) openaiMessages.push({ role: message.role, content: await resolveContentParts(message.content, user.sub) });
  }
  openaiMessages.push({ role: 'user', content: await resolveContentParts(body.new_user_message.content, user.sub) });

  const isFirstExchange = stored.filter(message => message.role === 'user').length === 1;
  const start = Date.now();
  let fullText = '';
  let assistantStored = false;
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({
        type: 'accepted',
        conversation_id: convId,
        assistant_message_id: assistantMsgId,
        user_message: {
          id: userMsgId,
          conversation_id: convId,
          role: 'user',
          content: body.new_user_message.content,
          model: null,
          status: 'done',
          timestamp: userTimestamp,
          edited_at: null,
        },
      }));
      try {
        const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: body.model, messages: openaiMessages, stream: true, ...(modelEntry.history_mode === 'latest_only' ? { session_id: convId } : {}) }),
          signal: c.req.raw.signal,
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 500);
          controller.enqueue(sse({ type: 'error', message: `upstream error ${response.status}${detail ? `: ${detail}` : ''}` }));
          controller.close();
          return;
        }
        if (!response.body) throw new Error('Upstream returned no response body');
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            for (const line of part.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') { done = true; break; }
              try {
                const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) { fullText += delta; controller.enqueue(sse({ type: 'delta', content: delta })); }
              } catch { /* ignore malformed SSE frames */ }
            }
            if (done) break;
          }
          if (done) break;
        }
        const assistantTimestamp = Date.now();
        if (!done) {
          if (fullText) {
            await db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', ?, ?, ?, 'aborted', ?)`)
              .run(assistantMsgId, convId, JSON.stringify([{ type: 'text', text: fullText }]), fullText, body.model, assistantTimestamp);
            assistantStored = true;
          }
          controller.enqueue(sse({ type: 'error', message: 'Upstream stream ended before completion' }));
          controller.close();
          return;
        }

        await db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp)
          VALUES (?, ?, 'assistant', ?, ?, ?, 'done', ?)
        `).run(assistantMsgId, convId, JSON.stringify([{ type: 'text', text: fullText }]), fullText, body.model, assistantTimestamp);
        assistantStored = true;
        const assistant = await db.prepare('SELECT * FROM messages WHERE id=?').get<MessageRow>(assistantMsgId);
        controller.enqueue(sse({ type: 'done', message: assistant ? serializeMessage(assistant) : null }));
        if (isFirstExchange && cfg.conversation.auto_title && fullText) {
          const title = await generateTitle(convId, body.model, cfg, userText, fullText);
          if (title) controller.enqueue(sse({ type: 'title', title }));
        }
        controller.close();
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          if (fullText && !assistantStored) await db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', ?, ?, ?, 'aborted', ?)`)
            .run(assistantMsgId, convId, JSON.stringify([{ type: 'text', text: fullText }]), fullText, body.model, Date.now());
        } else {
          if (fullText && !assistantStored) await db.prepare(`INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', ?, ?, ?, 'aborted', ?)`)
            .run(assistantMsgId, convId, JSON.stringify([{ type: 'text', text: fullText }]), fullText, body.model, Date.now());
          controller.enqueue(sse({ type: 'error', message: 'Upstream request failed' }));
        }
        controller.close();
      } finally {
        await closeStream(leaseId).catch(() => {});
        logger.info('Chat response complete', { user_sub: user.sub, model: body.model, conv_id: convId, latency_ms: Date.now() - start, aborted: c.req.raw.signal.aborted });
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } });
});

async function generateTitle(convId: string, model: string, cfg: ReturnType<typeof getConfig>, userPrompt: string, assistantResponse: string): Promise<string | null> {
  try {
    const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.conversation.auto_title_model || model, stream: false, max_tokens: 20, messages: [{ role: 'system', content: 'Return a 4-6 word title for this conversation. No punctuation, no quotes.' }, { role: 'user', content: `${userPrompt}\n\n${assistantResponse}`.slice(0, 2000) }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const title = data.choices?.[0]?.message?.content?.trim().slice(0, 80);
    if (title) await getDb().prepare("UPDATE conversations SET title=?, title_auto=true WHERE id=? AND title_auto=false AND title='New conversation'").run(title, convId);
    return title ?? null;
  } catch { return null; }
}
