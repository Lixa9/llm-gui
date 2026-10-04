import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompletionFrame,
  checkUpstreamResponse,
  isRetryable,
  boundedJson,
  UpstreamError,
} from '../src/upstream.ts';
import { contentPartSchema } from '../src/attachment-transport.ts';
test('provider errors distinguish deterministic input failures from transient failures', () => {
  for (const status of [400, 401, 403, 413]) {
    try {
      checkUpstreamResponse(new Response('', { status }));
      assert.fail();
    } catch (error) {
      assert.equal(isRetryable(error), false);
    }
  }
  for (const status of [408, 429, 500, 503]) {
    try {
      checkUpstreamResponse(new Response('', { status }));
      assert.fail();
    } catch (error) {
      assert.equal(isRetryable(error), true);
    }
  }
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});
test('stream parser detects refusal, tool-only replies, malformed data, and structured errors', () => {
  for (const frame of [
    { error: { message: 'bad' } },
    { choices: [{ delta: { refusal: 'no' } }] },
    { choices: [{ delta: { tool_calls: [{}] } }] },
    { choices: [{ finish_reason: 'content_filter' }] },
  ])
    assert.throws(() => parseCompletionFrame(JSON.stringify(frame)), UpstreamError);
  assert.throws(() => parseCompletionFrame('{bad'), UpstreamError);
  assert.equal(
    parseCompletionFrame('{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}').choices?.[0]
      ?.delta?.content,
    'ok',
  );
});
test('new media writes require managed references and strip arbitrary UI fields', () => {
  assert.equal(
    contentPartSchema.safeParse({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
      .success,
    false,
  );
  assert.equal(
    contentPartSchema.safeParse({ type: 'file', file: { url: 'https://example.test/file.pdf' } }).success,
    false,
  );
  const part = contentPartSchema.parse({
    type: 'file',
    file: { url: '/api/uploads/12345678-1234-1234-1234-123456789abc' },
    secret: 'not forwarded',
  });
  assert.equal('secret' in part, false);
});
test('non-streaming replies have a hard byte limit', async () => {
  await assert.rejects(boundedJson(new Response('x'.repeat(10000)), 100), /output limit/);
  await assert.rejects(boundedJson(new Response('not JSON'), 100), /invalid JSON/);
});

test('provider serialization uses native PDF file_data and supported image MIME without UI fields', async () => {
  const { resolveContentParts } = await import('../src/attachment-transport.ts');
  const model = {
    id: 'vision',
    display_name: 'Vision',
    allowed_roles: ['user' as const],
    capabilities: { vision: true, native_pdf: true, image_detail: 'high' as const },
  };
  const url = '/api/uploads/12345678-1234-1234-1234-123456789abc';
  let row = {
    filename: 'report.pdf',
    mime_type: 'application/pdf',
    data: Buffer.from('%PDF-1.7'),
    size: 8,
    extracted_text: null,
    file_meta: { processing_status: 'native_only' },
    derived_images: [] as Array<{ data: string; ext: string }>,
  };
  const db = { prepare: () => ({ get: async () => row }) } as unknown as ReturnType<
    typeof import('../src/db/index.ts').getDb
  >;
  const native = await resolveContentParts(
    [{ type: 'file', file: { url }, _filename: 'untrusted name' }],
    'owner',
    model,
    db,
  );
  assert.deepEqual(native, [
    { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjc=' } },
  ]);
  row = { ...row, file_meta: {processing_status:'ready'}, mime_type: 'image/tiff', derived_images: [{ data: 'AAAA', ext: '.png' }] } as typeof row;
  const converted = (await resolveContentParts(
    [{ type: 'image_url', image_url: { url } }],
    'owner',
    model,
    db,
  )) as Array<{ image_url?: { url: string; detail: string } }>;
  assert.equal(converted[1].image_url?.url, 'data:image/png;base64,AAAA');
  assert.equal(converted[1].image_url?.detail, 'high');
  await assert.rejects(
    resolveContentParts(
      [{ type: 'image_url', image_url: { url } }],
      'owner',
      { ...model, capabilities: { vision: false, native_pdf: false, image_detail: 'auto' } },
      db,
    ),
    /vision model/,
  );
  const missing = { prepare: () => ({ get: async () => undefined }) } as unknown as typeof db;
  await assert.rejects(
    resolveContentParts([{ type: 'file', file: { url } }], 'other-owner', model, missing),
    /missing/,
  );
});
test('usage diagnostics retain only numeric token counts', () => {
  const frame = parseCompletionFrame(JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      content: 'private document', invalid: 100,
    },
  }));
  assert.deepEqual(frame.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});
