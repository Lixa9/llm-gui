import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import type { ModelYamlEntry, MessageContentPart } from '../src/types.ts';
import type { TxDb } from '../src/db/index.ts';
import { responseCompression } from '../src/http-performance.ts';
import { serializeJson } from '../src/serialization.ts';
import { createCheckpointWriter } from '../src/checkpoint-writer.ts';

const configDir = await mkdtemp(join(tmpdir(), 'llm-performance-'));
process.env.CONFIG_DIR = configDir;
await writeFile(join(configDir, 'config.yaml'), 'app:\n  name: Test\nopenai:\n  base_url: http://example.invalid/v1\n');
for (const key of ['models', 'prompts', 'presets', 'automations'])
  await writeFile(join(configDir, `${key}.yaml`), `${key}: []\n`);
const { loadConfig, getConfig } = await import('../src/config.ts');
loadConfig();
const { createRequestBudget, assertRequestBudget, createAttachmentResolver, canonicalizeAttachments } = await import('../src/attachment-transport.ts');
const { fetchModels, invalidateModelCache, startModelRefresh, stopModelRefresh } = await import('../src/models.ts');
const model: ModelYamlEntry = { id: 'test', display_name: 'Test', allowed_roles: ['user'], capabilities: { vision: true, native_pdf: false, image_detail: 'auto' } };
test.after(async () => { stopModelRefresh(); await rm(configDir, { recursive: true, force: true }); });

test('health bypasses compression without changing successful or shutdown responses', async () => {
  let shuttingDown = false;
  const app = new Hono();
  app.use('*', responseCompression);
  app.get('/health', context => context.json({ status: shuttingDown ? 'shutting_down' : 'ok' }, shuttingDown ? 503 : 200));
  app.get('/api/test', context => context.json({ value: 'x'.repeat(2000) }));
  for (const encoding of ['gzip', 'deflate', 'identity', '*']) {
    const response = await app.request('/health', { headers: { 'Accept-Encoding': encoding } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Encoding'), null);
    assert.deepEqual(await response.json(), { status: 'ok' });
  }
  shuttingDown = true;
  const response = await app.request('/health', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Content-Encoding'), null);
  assert.deepEqual(await response.json(), { status: 'shutting_down' });
  const compressed = await app.request('/api/test', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.headers.get('Content-Encoding'), 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString()), { value: 'x'.repeat(2000) });
});

test('incremental budgets exactly match serialized prefixes including Unicode and native files', async () => {
  const messages = [
    { role: 'system', content: 'Quotes " \\ \n 😀\ud800' },
    { role: 'user', content: [{ type: 'text', text: 'ä\n你好' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } }] },
    { role: 'user', content: [{ type: 'file', file: { filename: 'é.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } }] },
    { role: 'assistant', content: 'x'.repeat(100000) },
  ];
  const budget = createRequestBudget(model);
  const prefix = [];
  for (const message of messages) {
    prefix.push(message);
    const actual = await budget.add(message);
    assert.equal(actual.bytes, Buffer.byteLength(JSON.stringify(prefix)));
    assert.deepEqual(actual, assertRequestBudget(prefix, model));
  }
  assert.deepEqual(budget.finish(), { bytes: Buffer.byteLength(JSON.stringify(messages)), images: 1, files: 1, text_chars: 100000 + messages[0].content.length + 'ä\n你好'.length });
});

test('incremental limits keep exact boundaries and existing error messages', async () => {
  const limits = getConfig().attachments;
  const before = { ...limits };
  try {
    const message = { role: 'user', content: '😀'.repeat(500) };
    limits.max_request_bytes = Buffer.byteLength(JSON.stringify([message]));
    await createRequestBudget(model).add(message);
    limits.max_request_bytes--;
    assert.throws(() => assertRequestBudget([message], model), /Conversation input exceeds/);
    await assert.rejects(createRequestBudget(model).add(message), /Conversation input exceeds/);
    Object.assign(limits, before);
    limits.max_text_chars = 1000;
    await assert.rejects(createRequestBudget(model).add({ role: 'user', content: 'x'.repeat(1001) }), /text context budget/);
    limits.max_images = 0;
    await assert.rejects(createRequestBudget(model).add({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }), /image\/file limit/);
  } finally { Object.assign(limits, before); }
});

test('attachment batching reads each upload once, preserves order, and isolates owners', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const parts: MessageContentPart[] = [{ type: 'image_url', image_url: { url: `/api/uploads/${id}` } }];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = { prepare: (sql: string) => ({ all: async (...params: unknown[]) => {
    calls.push({ sql, params });
    return params[1] === 'owner' ? [{ id, filename: 'image.png', mime_type: 'image/png', data: Buffer.from([0, 0, 0]), extracted_text: null, file_meta: {}, derived_images: [] }] : [];
  } }) } as unknown as TxDb;
  const resolve = await createAttachmentResolver([{ content: parts }, { content: parts }], 'owner', model, db);
  const first = await resolve(parts);
  assert.deepEqual(await resolve(parts), first);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [false, 'owner', [id]]);
  assert.match(calls[0].sql, /CASE WHEN/);
  const missing = await createAttachmentResolver([{ content: parts }], 'other', model, db);
  await assert.rejects(missing(parts), /historical attachment is missing/);
  await assert.rejects(resolve(parts, 'assistant'), /Only user messages/);
});

test('attachment canonicalization batches owner-scoped row locks and retains authoritative metadata', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const url = `/api/uploads/${id}`;
  let calls = 0;
  const db = { prepare: (sql: string) => ({ all: async (ids: string[], owner: string) => {
    calls++;
    assert.match(sql, /FOR KEY SHARE/);
    assert.deepEqual(ids, [id]);
    assert.equal(owner, 'owner');
    return [{ id, filename: 'actual.txt', mime_type: 'text/plain', file_meta: { warning: 'Actual warning' } }];
  } }) } as unknown as TxDb;
  const parts: MessageContentPart[] = [
    { type: 'text', text: 'Original text' },
    { type: 'file', file: { url }, _filename: 'spoofed' },
    { type: 'file', file: { url } },
  ];
  assert.deepEqual(await canonicalizeAttachments(parts, 'owner', db), [
    parts[0],
    { type: 'file', file: { url }, _filename: 'actual.txt', _mime_type: 'text/plain', _warning: 'Actual warning' },
    { type: 'file', file: { url }, _filename: 'actual.txt', _mime_type: 'text/plain', _warning: 'Actual warning' },
  ]);
  assert.equal(calls, 1);
  const missing = { prepare: () => ({ all: async () => [] }) } as unknown as TxDb;
  await assert.rejects(canonicalizeAttachments(parts, 'other', missing), /missing or no longer available/);
});

test('small JSON serialization stays exact without creating asynchronous large work', async () => {
  const value = { model: 'test', messages: [{ role: 'user', content: 'Hello' }], stream: true };
  assert.equal(await serializeJson(value), JSON.stringify(value));
});

test('large serialization uses identical JSON and permits HTTP-loop callbacks to run', async () => {
  const value = { model: 'test', messages: [{ role: 'user', content: '😀"\\\n'.repeat(150000) }], stream: true };
  const expected = JSON.stringify(value);
  await serializeJson({ warmup: 'x'.repeat(70000) });
  let yielded = false;
  const timer = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const actual = await serializeJson(value);
  assert.equal(actual, expected);
  assert.equal(yielded, true);
  await timer;
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, (_, index) => serializeJson({ index, value: 'x'.repeat(70000) }))),
    Array.from({ length: 4 }, (_, index) => JSON.stringify({ index, value: 'x'.repeat(70000) })));
});

test('simultaneous model lookups share one refresh and retain role filtering', async context => {
  invalidateModelCache();
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ data: [{ id: 'unknown' }] });
  });
  const lists = await Promise.all(Array.from({ length: 8 }, () => fetchModels('admin')));
  assert.equal(calls, 1);
  assert.ok(lists.every(list => list[0].id === 'unknown'));
  assert.deepEqual(await fetchModels('user'), []);
  assert.equal(calls, 1);
});

test('a rejected large serialization releases worker capacity for subsequent requests', async () => {
  await assert.rejects(serializeJson({ text: 'x'.repeat(70000), invalid: 1n }), /BigInt/);
  const values = Array.from({ length: 8 }, (_, index) => ({ index, text: '😀'.repeat(40000) }));
  assert.deepEqual(await Promise.all(values.map(value => serializeJson(value))), values.map(value => JSON.stringify(value)));
});

test('invalidated in-flight model refresh cannot overwrite the new cache', async context => {
  invalidateModelCache();
  let release!: (response: Response) => void;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ data: [{ id: 'new' }] });
  });
  const previous = fetchModels('admin');
  invalidateModelCache();
  assert.equal((await fetchModels('admin'))[0].id, 'new');
  release(Response.json({ data: [{ id: 'old' }] }));
  assert.equal((await previous)[0].id, 'new');
  assert.equal((await fetchModels('admin'))[0].id, 'new');
});

test('background model refresh starts once and can be stopped', async context => {
  invalidateModelCache();
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ data: [{ id: 'test' }] }); });
  startModelRefresh();
  startModelRefresh();
  await fetchModels('admin');
  assert.equal(calls, 1);
  stopModelRefresh();
});

test('background refresh keeps the TTL and expired reads wait for the same ongoing refresh', async context => {
  invalidateModelCache();
  context.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  let calls = 0;
  let release!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ data: [{ id: 'original' }] });
    return new Promise<Response>(resolve => { release = resolve; });
  });
  startModelRefresh();
  try {
    assert.equal((await fetchModels('admin'))[0].id, 'original');
    context.mock.timers.tick(45_000);
    assert.equal(calls, 2);
    assert.equal((await fetchModels('admin'))[0].id, 'original');
    context.mock.timers.tick(16_000);
    let completed = false;
    const reading = fetchModels('admin').then(models => { completed = true; return models; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(calls, 2);
    release(Response.json({ data: [{ id: 'updated' }] }));
    assert.equal((await reading)[0].id, 'updated');
  } finally { stopModelRefresh(); }
});

test('model discovery errors preserve existing fallback rather than an empty or unfiltered list', async context => {
  invalidateModelCache();
  const cfg = getConfig();
  const original = cfg.models;
  const configuredModel = { ...model, capabilities: { ...model.capabilities!, stream_usage: false } };
  cfg.models = [configuredModel];
  context.mock.method(globalThis, 'fetch', async () => new Response('private provider error', { status: 503 }));
  try {
    assert.deepEqual(await fetchModels('user'), [configuredModel]);
    assert.deepEqual(await fetchModels('admin'), []);
  } finally { cfg.models = original; invalidateModelCache(); }
});

test('slow checkpoints coalesce output without blocking submissions and drain before finalization', async () => {
  const writes: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const writer = createCheckpointWriter(async text => { writes.push(text); await waiting; return true; }, error => assert.fail(error), 0);
  writer.submit('first');
  await new Promise(resolve => setImmediate(resolve));
  writer.submit('second');
  writer.submit('latest');
  assert.deepEqual(writes, ['first']);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['first', 'latest']);
  await writer.stop();
  writer.submit('after stop');
  assert.deepEqual(writes, ['first', 'latest']);
});

test('checkpoint stop waits for in-flight writes and discards obsolete pending output', async () => {
  let release!: () => void;
  const writes: string[] = [];
  const writer = createCheckpointWriter(async text => {
    writes.push(text);
    await new Promise<void>(resolve => { release = resolve; });
    return true;
  }, error => assert.fail(error), 0);
  writer.submit('first');
  await new Promise(resolve => setImmediate(resolve));
  writer.submit('pending');
  let drained = false;
  const stopped = writer.stop().then(() => { drained = true; });
  assert.equal(drained, false);
  release();
  await stopped;
  assert.deepEqual(writes, ['first']);
});

test('checkpoint failures and lost leases stop further writes without unhandled rejections', async () => {
  for (const fail of [false, true]) {
    const errors: Error[] = [];
    let writes = 0;
    const writer = createCheckpointWriter(async () => { writes++; if (fail) throw new Error('db unavailable'); return false; }, error => errors.push(error), 0);
    writer.submit('text');
    await new Promise(resolve => setImmediate(resolve));
    writer.submit('ignored');
    await writer.stop();
    assert.equal(writes, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, fail ? /db unavailable/ : /lost its lease/);
  }
});
