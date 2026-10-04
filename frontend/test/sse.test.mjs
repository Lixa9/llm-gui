import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatStreamInterruptedError, streamChat } from '../src/lib/sse.ts';

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

test('streamChat treats cancellation as a terminal event', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => responseWithEvents([
    { type: 'cancelled', message: { id: 'a', status: 'aborted' } },
  ]));
  const events = [];
  await streamChat(payload, new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['cancelled']);
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

test('streamChat propagates event handler failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => responseWithEvents([{ type: 'done' }]));
  await assert.rejects(streamChat(payload, new AbortController().signal, () => { throw new Error('state failure'); }), /state failure/);
});

test('streamChat bounds unterminated frames and rejects malformed frames', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: ' + 'x'.repeat(2 * 1024 * 1024)));
  await assert.rejects(streamChat(payload, new AbortController().signal, () => {}), /streaming limit/);
  t.mock.method(globalThis, 'fetch', async () => new Response('data: {invalid}\n\n'));
  await assert.rejects(streamChat(payload, new AbortController().signal, () => {}), /Invalid response frame/);
});

test('streamChat ignores keep-alives while waiting for a hardcoded mock reply', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    ': keep-alive\n\ndata: {"type":"delta","content":"hardcoded response"}\n\n: keep-alive\n\ndata: {"type":"done"}\n\n',
  ));
  const events = [];
  await streamChat(payload, new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['delta', 'done']);
});

test('browser input stream failures are recoverable transport interruptions', async t => {
  const cause = new TypeError('error in input stream');
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"accepted"}\n\n'));
      else controller.error(cause);
    },
  })));
  const events = [];
  await assert.rejects(streamChat(payload, new AbortController().signal, event => events.push(event)), error => {
    assert.ok(error instanceof ChatStreamInterruptedError);
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /error in input stream/);
    return true;
  });
  assert.deepEqual(events.map(event => event.type), ['accepted']);
});

test('terminal events finish without waiting for socket close or surfacing a later read error', async t => {
  for (const event of [{ type: 'done' }, { type: 'cancelled' }, { type: 'error', message: 'Provider rejected input' }]) {
    let cancelled = false;
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        // Leave the socket open, as a mock or proxy may do after a terminal event.
      },
      cancel() { cancelled = true; },
    })));
    const events = [];
    await streamChat(payload, new AbortController().signal, value => events.push(value));
    assert.deepEqual(events, [event]);
    assert.equal(cancelled, true);
  }
});

test('user cancellation remains an abort rather than a recoverable interruption', async t => {
  const abort = new DOMException('Cancelled', 'AbortError');
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(stream) {
      controller.abort();
      stream.error(abort);
    },
  })));
  await assert.rejects(streamChat(payload, controller.signal, () => {}), error => error === abort);
});
