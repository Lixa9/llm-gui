import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { checkRateLimit, openStream, closeStream } from './ratelimit';
import { logger } from './logger';
import type { SessionPayload, MessageRow, MessageContentPart, ToolCall } from './types';

export const relayRouter = new Hono();
relayRouter.use('*', requireAuth);

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsBuffer: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractText(content: MessageContentPart[]): string {
  return content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n');
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

relayRouter.post('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const start = Date.now();

  // Rate limit check
  const rl = checkRateLimit(user.sub);
  if (!rl.allowed) {
    return c.json({ error: rl.reason }, 429);
  }

  const body = await c.req.json() as {
    conversation_id: string | null;
    model: string;
    system_prompt?: string;
    system_prompt_id?: string;
    messages: Array<{
      role: 'user' | 'assistant';
      content: MessageContentPart[];
      tool_calls?: ToolCall[];
    }>;
    new_user_message: { content: MessageContentPart[] };
  };

  const cfg = getConfig();
  if (!cfg.litellm.base_url) {
    return c.json({ error: 'LiteLLM is not configured. Set litellm.base_url in config.yaml.' }, 503);
  }
  const db = getDb();

  // Resolve conversation
  let convId = body.conversation_id;
  if (!convId) {
    convId = generateId();
    db.query('INSERT INTO conversations (id, owner_sub, model_id, custom_system_prompt) VALUES (?, ?, ?, ?)')
      .run(convId, user.sub, body.model, body.system_prompt ?? null);
  }

  // Persist user message
  const userMsgId = generateId();
  const userContent = JSON.stringify(body.new_user_message.content);
  const userText = extractText(body.new_user_message.content);
  db.query(
    'INSERT INTO messages (id, conversation_id, role, content, content_text, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userMsgId, convId, 'user', userContent, userText, 'done');

  // Build OpenAI messages array with context window truncation
  const allMessages = body.messages ?? [];
  const systemPrompt = body.system_prompt;
  const windowTokens = cfg.conversation.context_window_tokens - cfg.conversation.context_window_reserve;

  let tokenCount = systemPrompt ? estimateTokens(systemPrompt) : 0;
  tokenCount += estimateTokens(userText);

  const trimmed: typeof allMessages = [];
  for (const msg of [...allMessages].reverse()) {
    const msgTokens = estimateTokens(extractText(msg.content));
    if (tokenCount + msgTokens > windowTokens && trimmed.length > 0) break;
    tokenCount += msgTokens;
    trimmed.unshift(msg);
  }

  const openaiMessages: unknown[] = [];
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt });
  for (const msg of trimmed) {
    openaiMessages.push({
      role: msg.role,
      content: msg.content,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })) } : {}),
    });
  }
  openaiMessages.push({ role: 'user', content: body.new_user_message.content });

  openStream(user.sub);

  const encoder = new TextEncoder();
  let fullText = '';
  const toolAccumulators = new Map<number, ToolCallAccumulator>();
  let assistantMsgId = generateId();
  let isFirstExchange = allMessages.filter(m => m.role === 'user').length === 0;

  const stream = new ReadableStream({
    async start(controller) {
      let liteLLMRes: Response | null = null;
      try {
        liteLLMRes = await fetch(`${cfg.litellm.base_url}/chat/completions`, {
          method: 'POST',
          headers: {
            ...(cfg.litellm.api_key ? { Authorization: `Bearer ${cfg.litellm.api_key}` } : {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: body.model,
            messages: openaiMessages,
            stream: true,
          }),
          signal: c.req.raw.signal,
        });

        if (!liteLLMRes.ok) {
          const errText = await liteLLMRes.text();
          controller.enqueue(sse({ type: 'error', message: `LiteLLM error ${liteLLMRes.status}: ${errText}` }));
          controller.close();
          return;
        }

        const buf = new TextDecoder();
        let lineBuf = '';

        for await (const chunk of liteLLMRes.body as unknown as AsyncIterable<Uint8Array>) {
          lineBuf += buf.decode(chunk, { stream: true });
          const parts = lineBuf.split('\n\n');
          lineBuf = parts.pop() ?? '';

          for (const part of parts) {
            for (const line of part.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') {
                // Emit accumulated tool calls
                for (const [, acc] of toolAccumulators) {
                  let parsedArgs: unknown;
                  try { parsedArgs = JSON.parse(acc.argumentsBuffer); }
                  catch { parsedArgs = acc.argumentsBuffer; }
                  controller.enqueue(sse({ type: 'tool_call', id: acc.id, name: acc.name, arguments: parsedArgs, index: 0 }));
                }

                // Persist assistant message
                const toolCallsJson = toolAccumulators.size > 0
                  ? JSON.stringify([...toolAccumulators.values()].map((acc, idx) => ({
                      id: acc.id,
                      name: acc.name,
                      arguments: (() => { try { return JSON.parse(acc.argumentsBuffer); } catch { return acc.argumentsBuffer; } })(),
                      index: idx,
                    })))
                  : null;
                const assistantContent = JSON.stringify([{ type: 'text', text: fullText }]);
                db.query(
                  'INSERT INTO messages (id, conversation_id, role, content, content_text, tool_calls, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).run(assistantMsgId, convId, 'assistant', assistantContent, fullText, toolCallsJson, body.model, 'done');

                controller.enqueue(sse({ type: 'done' }));

                // Auto-title
                if (isFirstExchange && cfg.conversation.auto_title) {
                  generateTitle(convId!, body.model, cfg, user.sub, db).then(title => {
                    if (title) {
                      controller.enqueue(sse({ type: 'title', title }));
                    }
                  }).catch(() => {});
                }

                controller.close();
                return;
              }

              try {
                const parsed = JSON.parse(dataStr) as {
                  choices: Array<{
                    delta: {
                      content?: string;
                      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                    };
                  }>;
                };
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                  fullText += delta.content;
                  controller.enqueue(sse({ type: 'delta', content: delta.content }));
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (!toolAccumulators.has(tc.index)) {
                      toolAccumulators.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', argumentsBuffer: '' });
                    } else {
                      if (tc.id) toolAccumulators.get(tc.index)!.id = tc.id;
                      if (tc.function?.name) toolAccumulators.get(tc.index)!.name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      toolAccumulators.get(tc.index)!.argumentsBuffer += tc.function.arguments;
                    }
                  }
                }
              } catch {
                // malformed chunk — skip
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          // Save partial response
          if (fullText) {
            const partialContent = JSON.stringify([{ type: 'text', text: fullText }]);
            db.query(
              'INSERT INTO messages (id, conversation_id, role, content, content_text, model, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(assistantMsgId, convId, 'assistant', partialContent, fullText, body.model, 'aborted');
          }
        } else {
          controller.enqueue(sse({ type: 'error', message: (e as Error).message }));
        }
        controller.close();
      } finally {
        closeStream(user.sub);
        logger.info('Chat relay complete', {
          user_sub: user.sub,
          model: body.model,
          latency_ms: Date.now() - start,
          conv_id: convId,
          aborted: (c.req.raw.signal as AbortSignal).aborted,
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    },
  });
});

async function generateTitle(
  convId: string,
  model: string,
  cfg: ReturnType<typeof getConfig>,
  userSub: string,
  db: ReturnType<typeof getDb>,
): Promise<string | null> {
  try {
    const msgs = db.query<{ content_text: string }, [string]>(
      "SELECT content_text FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY timestamp LIMIT 4"
    ).all(convId);

    const context = msgs.map(m => m.content_text).join('\n\n').slice(0, 2000);
    const titleModel = cfg.conversation.auto_title_model ?? model;

    const res = await fetch(`${cfg.litellm.base_url}/chat/completions`, {
      method: 'POST',
      headers: { ...(cfg.litellm.api_key ? { Authorization: `Bearer ${cfg.litellm.api_key}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: titleModel,
        stream: false,
        max_tokens: 20,
        messages: [
          { role: 'system', content: 'Return a 4-6 word title for this conversation. No punctuation, no quotes.' },
          { role: 'user', content: context },
        ],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const title = data.choices[0]?.message?.content?.trim().slice(0, 80);
    if (title) {
      db.query('UPDATE conversations SET title=?, title_auto=1 WHERE id=?').run(title, convId);
    }
    return title ?? null;
  } catch {
    return null;
  }
}
