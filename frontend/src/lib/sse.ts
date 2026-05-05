import type { ChatPayload, SSEEvent } from './types';

export async function streamChat(
  payload: ChatPayload,
  signal: AbortSignal,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
    signal,
  });

  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json() as { error: string }).error ?? msg; } catch { /* ignore */ }
    onEvent({ type: 'error', message: msg });
    return;
  }

  if (!res.body) {
    onEvent({ type: 'error', message: 'No response body' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data) as SSEEvent;
            onEvent(event);
          } catch {
            // malformed chunk, skip
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      onEvent({ type: 'error', message: (err as Error).message });
    }
  } finally {
    reader.releaseLock();
  }
}
