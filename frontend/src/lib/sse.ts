import type { ChatPayload, RegenerateChatPayload, SSEEvent } from './types';

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
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';

      for (const part of parts) {
        for (const line of part.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data) as SSEEvent;
            if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') terminalEvent = true;
            onEvent(event);
          } catch {
            // malformed chunk, skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!terminalEvent) throw new Error('Connection closed before the response completed');
}
