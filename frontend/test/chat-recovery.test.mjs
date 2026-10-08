import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileModule } from 'svelte/compiler';

// Compile the actual rune store with Svelte, replacing only its I/O dependencies.
// Server generation makes its synchronous state inspectable without a DOM.
async function loadStore(t, api) {
  const key = `chatRecovery_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[key] = api;
  t.after(() => { delete globalThis[key]; });
  const stub = code => `data:text/javascript,${encodeURIComponent(code)}`;
  let source = stripTypeScriptTypes(await readFile(new URL('../src/stores/chat.svelte.ts', import.meta.url), 'utf8'));
  source = source
    .replace("'$lib/sse'", JSON.stringify(new URL('../src/lib/sse.ts', import.meta.url).href))
    .replace("'$lib/api'", JSON.stringify(stub(`export const api = globalThis[${JSON.stringify(key)}];`)))
    .replace("'$lib/audio'", JSON.stringify(stub('export function playCompletionSound() {}')))
    .replace("'./conversations.svelte'", JSON.stringify(stub('export const conversationsStore = { refreshUntilTitle: async () => {} };')))
    .replace("'./preferences.svelte'", JSON.stringify(stub('export const preferencesStore = { soundEnabled: false, soundVolume: 0 };')));
  const { js } = compileModule(source, { filename: 'chat.svelte.js', generate: 'server' });
  const compiled = js.code.replace("'svelte/internal/server'", JSON.stringify(import.meta.resolve('svelte/internal/server')));
  const { chatStore } = await import(stub(compiled));
  t.after(() => chatStore.clear());
  return chatStore;
}

const conversationId = '4debad6e-b303-4fb3-aafd-fca8e5f210f5';
const payload = {
  conversation_id: conversationId,
  model: 'mock',
  new_user_message: { content: [
    { type: 'text', text: 'Summarize this 250-page PDF' },
    { type: 'file', file: { url: '/api/uploads/12345678-1234-1234-1234-123456789abc' } },
  ] },
};

function mockBrokenStream(t, state) {
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    const request = JSON.parse(options.body);
    const user = { id: request.new_user_message?.id ?? 'user', conversation_id: conversationId,
      role: 'user', content: payload.new_user_message.content, timestamp: 1, status: 'done' };
    const assistant = { id: request.assistant_message_id ?? 'regenerated', conversation_id: conversationId,
      role: 'assistant', content: [], timestamp: 2, status: 'streaming' };
    state.messages = [user, assistant];
    state.generation = { id: assistant.id, conversation_id: conversationId,
      assistant_message_id: assistant.id, status: 'running', message: assistant, last_error: null };
    let reads = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: 'accepted', conversation_id: conversationId, assistant_message_id: assistant.id, user_message: user,
        })}\n\n`));
        else controller.error(new TypeError('error in input stream'));
      },
    }));
  });
}

for (const action of ['send', 'regenerate']) {
  test(`${action} recovers an interrupted PDF response through the durable generation`, async t => {
    const state = { messages: [], generation: null };
    mockBrokenStream(t, state);
    const store = await loadStore(t, {
      conversations: { messages: async () => state.messages },
      chat: { generation: async () => state.generation },
    });
    if (action === 'regenerate') {
      state.messages = [
        { id: 'user', role: 'user', content: payload.new_user_message.content, timestamp: 1, status: 'done' },
        { id: 'old', role: 'assistant', content: [], timestamp: 2, status: 'done' },
      ];
      await store.loadMessages(conversationId);
      await store.regenerate({ conversation_id: conversationId, assistant_message_id: 'old', model: 'mock' });
    } else {
      const result = await store.send(payload);
      assert.equal(result.accepted, true, 'accepted PDF must not be resubmitted');
    }
    assert.equal(store.error, null);
    assert.equal(store.streaming, true);
    assert.equal(store.activeGenerationId, state.generation.id);
    state.generation = { ...state.generation, status: 'done', message: {
      ...state.generation.message, status: 'done', content: [{ type: 'text', text: 'hardcoded response' }],
    } };
    // The store polls the existing job instead of making another completion request.
    const deadline = Date.now() + 2000;
    while (store.streaming && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.streaming, false);
    assert.equal(store.error, null);
    assert.equal(store.messages.at(-1).content[0].text, 'hardcoded response');
  });
}

test('disconnect recovery preserves a provider failure already saved by the job', async t => {
  const state = { messages: [], generation: null };
  mockBrokenStream(t, state);
  const store = await loadStore(t, {
    conversations: { messages: async () => {
      state.generation = { ...state.generation, status: 'failed', last_error: 'Provider returned HTTP 400',
        message: { ...state.generation.message, status: 'failed' } };
      return state.messages.map(message => message.role === 'assistant' ? state.generation.message : message);
    } },
    chat: { generation: async () => state.generation },
  });
  await store.send(payload);
  assert.equal(store.streaming, false);
  assert.equal(store.error, 'Provider returned HTTP 400');
});

function responseWithEvents(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function savedMessages() {
  return [
    { id: 'user', conversation_id: conversationId, role: 'user', content: payload.new_user_message.content, timestamp: 1, status: 'done' },
    { id: 'old', conversation_id: conversationId, role: 'assistant', content: [{ type: 'text', text: 'original answer' }], timestamp: 2, status: 'done' },
  ];
}

for (const action of ['send', 'regenerate']) {
  for (const terminal of ['done', 'cancelled', 'error']) {
    test(`${action} shares acceptance and ${terminal} handling without changing its endpoint`, async context => {
      let messages = savedMessages();
      let acceptedConversation = null;
      const store = await loadStore(context, { conversations: { messages: async () => messages } });
      if (action === 'regenerate') await store.loadMessages(conversationId);
      context.mock.method(globalThis, 'fetch', async (path, options) => {
        assert.equal(path, action === 'send' ? '/api/chat' : '/api/chat/regenerate');
        const request = JSON.parse(options.body);
        const user = action === 'send'
          ? { ...messages[0], id: request.new_user_message.id }
          : messages[0];
        const assistant = { ...messages[1], id: request.assistant_message_id, status: terminal === 'cancelled' ? 'aborted' : terminal === 'error' ? 'failed' : 'done' };
        messages = [user, assistant];
        return responseWithEvents([
          { type: 'accepted', conversation_id: conversationId, assistant_message_id: assistant.id, user_message: user },
          { type: 'delta', content: 'partial answer' },
          terminal === 'error' ? { type: 'error', message: 'Provider rejected input' } : { type: terminal, message: assistant },
        ]);
      });
      if (action === 'send') {
        const result = await store.send(payload, id => { acceptedConversation = id; });
        assert.deepEqual(result, { accepted: true });
        assert.equal(acceptedConversation, conversationId);
      } else {
        assert.equal(await store.regenerate({ conversation_id: conversationId, assistant_message_id: 'old', model: 'mock' }), undefined);
      }
      assert.equal(store.streaming, false);
      assert.equal(store.pending, null);
      assert.equal(store.activeGenerationId, null);
      assert.deepEqual(store.messages, messages);
      assert.equal(store.error, terminal === 'error' ? 'Provider rejected input' : null);
    });
  }
}

for (const action of ['edit', 'regenerate']) {
  test(`a rejected ${action} keeps the authoritative history`, async context => {
    const original = savedMessages();
    const store = await loadStore(context, { conversations: { messages: async () => original } });
    await store.loadMessages(conversationId);
    let accepted = false;
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
    if (action === 'edit') {
      assert.deepEqual(await store.send({ ...payload, edit_message_id: 'user' }, () => { accepted = true; }), { accepted: false });
    } else {
      await store.regenerate({ conversation_id: conversationId, assistant_message_id: 'old', model: 'mock' });
    }
    assert.equal(accepted, false);
    assert.deepEqual(store.messages, original);
    assert.equal(store.error, 'rate limited');
    assert.equal(store.streaming, false);
    assert.equal(store.activeGenerationId, null);
  });
}

test('a rejected edit restores the original messages if reconciliation also fails', async context => {
  const original = savedMessages();
  let rejectReload = false;
  const store = await loadStore(context, { conversations: { messages: async () => {
    if (rejectReload) throw new Error('offline');
    return original;
  } } });
  await store.loadMessages(conversationId);
  rejectReload = true;
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
  assert.deepEqual(await store.send({ ...payload, edit_message_id: 'user', new_user_message: { content: [{ type: 'text', text: 'edited' }] } }), { accepted: false });
  assert.deepEqual(store.messages.map(message => message.content), original.map(message => message.content));
  assert.equal(store.error, 'rate limited');
  assert.equal(store.streaming, false);
});

test('leaving a conversation detaches an accepted stream without cancelling its generation', async context => {
  let messages = [];
  const store = await loadStore(context, { conversations: { messages: async () => messages } });
  context.mock.method(globalThis, 'fetch', async (_path, options) => {
    const request = JSON.parse(options.body);
    const user = { ...savedMessages()[0], id: request.new_user_message.id };
    messages = [user];
    return new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Detached', 'AbortError')), { once: true });
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'accepted', conversation_id: conversationId, assistant_message_id: request.assistant_message_id, user_message: user })}\n\n`));
      },
    }));
  });
  const result = await store.send(payload, () => store.setActiveConversation('another-conversation'));
  assert.deepEqual(result, { accepted: true });
  assert.equal(store.activeConversationId, 'another-conversation');
  assert.deepEqual(store.messages, []);
  assert.equal(store.error, null);
  assert.equal(store.streaming, false);
});

test('stop waits for acceptance and uses the authoritative generation ID', async context => {
  let messages = [];
  let cancelledId = null;
  let request;
  let streamController;
  const store = await loadStore(context, {
    conversations: { messages: async () => messages },
    chat: { cancel: async id => {
      cancelledId = id;
      messages = [messages[0], { ...savedMessages()[1], id, status: 'aborted' }];
      return { id, conversation_id: conversationId, status: 'cancelled', message: messages[1] };
    } },
  });
  context.mock.method(globalThis, 'fetch', async (_path, options) => {
    request = JSON.parse(options.body);
    return new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true });
      },
    }));
  });
  const sending = store.send(payload);
  const stopping = store.stop();
  assert.equal(cancelledId, null);
  const user = { ...savedMessages()[0], id: request.new_user_message.id };
  messages = [user];
  streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'accepted', conversation_id: conversationId, assistant_message_id: 'authoritative-generation', user_message: user })}\n\n`));
  await stopping;
  assert.deepEqual(await sending, { accepted: true });
  assert.equal(cancelledId, 'authoritative-generation');
  assert.equal(store.messages.at(-1).status, 'aborted');
  assert.equal(store.streaming, false);
  assert.equal(store.error, null);
});
