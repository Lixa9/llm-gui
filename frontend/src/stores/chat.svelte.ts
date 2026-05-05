import { streamChat } from '$lib/sse';
import { api } from '$lib/api';
import { playCompletionSound } from '$lib/audio';
import type { Message, MessageContentPart, ToolCall, ChatPayload } from '$lib/types';
import { conversationsStore } from './conversations.svelte';
import { preferencesStore } from './preferences.svelte';

export interface PendingMessage {
  role: 'assistant';
  content: string;
  tool_calls: ToolCall[];
}

function createChatStore() {
  let messages = $state<Message[]>([]);
  let pending = $state<PendingMessage | null>(null);
  let streaming = $state(false);
  let loadingMessages = $state(false);
  let error = $state<string | null>(null);
  let abortController: AbortController | null = null;

  const allMessages = $derived<Array<Message | PendingMessage>>(
    pending ? [...messages, pending] : messages,
  );

  async function loadMessages(convId: string) {
    loadingMessages = true;
    error = null;
    try {
      messages = await api.conversations.messages(convId);
    } catch (e) {
      error = (e as Error).message;
      messages = [];
    } finally {
      loadingMessages = false;
    }
  }

  async function send(payload: ChatPayload) {
    if (streaming) return;
    streaming = true;
    error = null;
    abortController = new AbortController();
    pending = { role: 'assistant', content: '', tool_calls: [] };

    const isFirstExchange = messages.filter(m => m.role === 'user').length === 0;

    try {
      await streamChat(payload, abortController.signal, (event) => {
        if (event.type === 'delta') {
          if (pending) pending.content += event.content;
        } else if (event.type === 'tool_call') {
          if (pending) {
            pending.tool_calls = [...pending.tool_calls, {
              id: event.id,
              name: event.name,
              arguments: event.arguments,
              index: event.index,
            }];
          }
        } else if (event.type === 'done') {
          if (pending) {
            const finishedMessage: Message = {
              id: crypto.randomUUID(),
              conversation_id: payload.conversation_id ?? '',
              role: 'assistant',
              content: [{ type: 'text', text: pending.content }],
              tool_calls: pending.tool_calls.length > 0 ? pending.tool_calls : null,
              tool_results: null,
              model: payload.model,
              tokens_in: event.tokens_in ?? null,
              tokens_out: event.tokens_out ?? null,
              status: 'done',
              timestamp: Date.now(),
              edited_at: null,
            };
            messages = [...messages, finishedMessage];
            pending = null;
          }
          playCompletionSound(
            preferencesStore.soundEnabled,
            preferencesStore.soundVolume,
          );
        } else if (event.type === 'title' && payload.conversation_id) {
          conversationsStore.updateTitle(payload.conversation_id, event.title);
        } else if (event.type === 'error') {
          error = event.message;
          pending = null;
        }
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        error = (e as Error).message;
      }
      pending = null;
    } finally {
      streaming = false;
      abortController = null;
    }
  }

  function stop() {
    abortController?.abort();
  }

  async function editUserMessage(convId: string, msgId: string, newContent: string) {
    // Delete this message and everything after it, then re-send
    await api.conversations.deleteMessage(convId, msgId);
    // Reload messages (server deleted this msg + subsequent)
    await loadMessages(convId);
  }

  async function editAssistantMessage(convId: string, msgId: string, newContent: string) {
    const updated = await api.conversations.editMessage(convId, msgId, newContent);
    messages = messages.map(m => m.id === msgId ? updated : m);
  }

  async function deleteMessage(convId: string, msgId: string) {
    await api.conversations.deleteMessage(convId, msgId);
    // Remove this message and all after it from local state
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx !== -1) messages = messages.slice(0, idx);
  }

  function clear() {
    messages = [];
    pending = null;
    error = null;
    streaming = false;
  }

  return {
    get messages() { return messages; },
    get pending() { return pending; },
    get streaming() { return streaming; },
    get loadingMessages() { return loadingMessages; },
    get error() { return error; },
    get allMessages() { return allMessages; },
    loadMessages, send, stop, editUserMessage, editAssistantMessage, deleteMessage, clear,
  };
}

export const chatStore = createChatStore();
