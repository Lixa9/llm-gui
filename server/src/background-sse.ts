import { trackBackgroundTask } from './lifecycle.ts';

export interface BackgroundSseClient {
  send(event: unknown): void;
}

/**
 * Run work independently from the HTTP connection while exposing its live
 * events to the client for as long as that client remains connected.
 *
 * A ReadableStream controller becomes unusable after its consumer cancels the
 * stream. All writes are therefore best-effort; cancellation detaches the
 * observer, but deliberately does not cancel the background task.
 */
export function createBackgroundSseResponse(
  acceptedEvent: unknown,
  task: (client: BackgroundSseClient) => Promise<void>,
  onTaskError: (error: unknown) => void,
): Response {
  let connected = true;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        clearInterval(heartbeat);
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { connected = false; }
      };
      const write = (payload: Uint8Array) => {
        if (!connected || closed) return;
        try {
          if (payload.byteLength > 2 * 1024 * 1024 || (controller.desiredSize ?? 0) < payload.byteLength) {
            connected = false;
            close();
            return;
          }
          controller.enqueue(payload);
        } catch {
          connected = false;
          clearInterval(heartbeat);
        }
      };
      const client: BackgroundSseClient = {
        send(event) {
          if (!connected || closed) return;
          try { write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
          catch { connected = false; close(); }
        },
      };

      client.send(acceptedEvent);
      // Large documents may take a while to produce the first model token.
      // SSE comments keep idle browser/proxy connections alive without creating
      // chat events or changing the generation's upstream timeout.
      if (connected && !closed) {
        heartbeat = setInterval(() => write(encoder.encode(': keep-alive\n\n')), 15_000);
        heartbeat.unref();
      }
      trackBackgroundTask(
        Promise.resolve()
          .then(() => task(client))
          .catch(error => {
            client.send({ type: 'error', message: 'Could not stream the response. Check the saved response or try again.' });
            onTaskError(error);
          })
          .finally(close),
      );
    },
    cancel() {
      connected = false;
      clearInterval(heartbeat);
    },
  }, { highWaterMark: 2 * 1024 * 1024, size: chunk => chunk.byteLength });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
