import { trackBackgroundTask } from './lifecycle';

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
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const client: BackgroundSseClient = {
        send(event) {
          if (!connected || closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            connected = false;
          }
        },
      };

      client.send(acceptedEvent);
      trackBackgroundTask(
        Promise.resolve()
          .then(() => task(client))
          .catch(onTaskError)
          .finally(() => {
            if (!connected || closed) return;
            closed = true;
            try {
              controller.close();
            } catch {
              connected = false;
            }
          }),
      );
    },
    cancel() {
      connected = false;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
