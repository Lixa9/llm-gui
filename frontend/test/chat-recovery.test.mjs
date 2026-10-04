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
