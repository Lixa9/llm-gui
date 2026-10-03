/** Provider errors are classified without retaining response bodies or prompts. */
export class UpstreamError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}
export function isRetryable(error: unknown): boolean {
  return error instanceof UpstreamError
    ? error.retryable
    : error instanceof TypeError ||
        (error instanceof Error && /fetch|network|socket|ECONN|EAI_AGAIN|stream ended/i.test(error.message));
}
export function checkUpstreamResponse(response: Response): void {
  if (!response.ok)
    throw new UpstreamError(
      `Provider returned HTTP ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
}
export interface CompletionFrame {
  choices?: Array<{
    delta?: { content?: string; refusal?: string; tool_calls?: unknown[] };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
  error?: unknown;
}
export function parseCompletionFrame(data: string): CompletionFrame {
  let frame: CompletionFrame;
  try {
    frame = JSON.parse(data);
  } catch {
    throw new UpstreamError('Provider sent malformed streaming data');
  }
  if (!frame || typeof frame !== 'object' || frame.error)
    throw new UpstreamError('Provider reported a stream error');
  if (frame.usage) {
    const numeric = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    frame.usage = Object.fromEntries(Object.entries(frame.usage).filter(([key, value]) =>
      ['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && numeric(value),
    ));
  }
  const choice = frame.choices?.[0];
  if (choice?.delta?.refusal) throw new UpstreamError('The model refused this request');
  if (choice?.delta?.tool_calls?.length)
    throw new UpstreamError('This model returned tool calls; this chat supports text responses');
  if (choice?.finish_reason && !['stop', 'length'].includes(choice.finish_reason))
    throw new UpstreamError(`Model stopped with ${choice.finish_reason}`);
  if (choice?.delta?.content !== undefined && typeof choice.delta.content !== 'string')
    throw new UpstreamError('Provider returned unsupported response content');
  return frame;
}
export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  checkUpstreamResponse(response);
  if (!response.body) throw new UpstreamError('Provider returned no response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new UpstreamError('Provider response exceeds the configured output limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UpstreamError('Provider returned invalid JSON');
    throw error;
  }
}
