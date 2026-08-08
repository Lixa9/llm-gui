import assert from 'node:assert/strict';
import test from 'node:test';
import { streamChat } from '../src/lib/sse.ts';

const payload = {
  conversation_id: '4debad6e-b303-4fb3-aafd-fca8e5f210f5',
  model: 'test-model',
  new_user_message: { content: [{ type: 'text', text: 'Hello' }] },
};

function responseWithEvents(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }), { status: 200 });
}

function responseWithCrlfEvents(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
      controller.close();
    },
  }), { status: 200 });
}

test('streamChat delivers authoritative terminal events', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => responseWithEvents([
    { type: 'accepted', conversation_id: payload.conversation_id, assistant_message_id: 'a', user_message: { id: 'u' } },
    { type: 'delta', content: 'Hi' },
    { type: 'done', message: { id: 'a' } },
  ]));
  const events = [];
  await streamChat(payload, new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['accepted', 'delta', 'done']);
});

test('streamChat accepts CRLF-delimited SSE frames', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => responseWithCrlfEvents([
    { type: 'done', message: { id: 'a' } },
  ]));
  const events = [];
  await streamChat(payload, new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['done']);
});

test('streamChat rejects a response that closes without a terminal event', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => responseWithEvents([{ type: 'delta', content: 'partial' }]));
  await assert.rejects(
    streamChat(payload, new AbortController().signal, () => {}),
    /closed before the response completed/,
  );
});

test('streamChat surfaces an HTTP rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  }));
  await assert.rejects(
    streamChat(payload, new AbortController().signal, () => {}),
    /rate limited/,
  );
});
