import type { ChatPayload, RegenerateChatPayload, SSEEvent } from './types';

/** The saved generation can still finish when its HTTP observer disconnects. */
export class ChatStreamInterruptedError extends Error {
  constructor(cause?: unknown) {
    super('Connection closed before the response completed. Checking the saved response.', { cause });
    this.name = 'ChatStreamInterruptedError';
  }
}

export async function streamChat(
  payload: ChatPayload | RegenerateChatPayload,
  signal: AbortSignal,
  onEvent: (event: SSEEvent) => void,
  path = '/api/chat',
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'llm-frontend',
    },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
    signal,
  });

  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json() as { error: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!res.body) {
    throw new Error('No response body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminalEvent = false;

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (cause) {
        if (signal.aborted) throw cause;
        throw new ChatStreamInterruptedError(cause);
      }
      const { done, value } = chunk;
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      if (buf.length > 2 * 1024 * 1024) throw new Error('Response frame exceeds the streaming limit');
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';

      for (const part of parts) {
        for (const line of part.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let event: SSEEvent;
          try { event = JSON.parse(data) as SSEEvent; }
          catch { throw new Error('Invalid response frame'); }
          if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') terminalEvent = true;
          onEvent(event);
          // The authoritative result is complete; a later socket failure must
          // not turn a saved answer or provider error into a transport error.
          if (terminalEvent) return;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (!terminalEvent) throw new ChatStreamInterruptedError();
}
