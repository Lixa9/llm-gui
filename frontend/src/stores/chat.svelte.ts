import { streamChat } from '$lib/sse';
import { api } from '$lib/api';
import { playCompletionSound } from '$lib/audio';
import type { Message, ChatPayload } from '$lib/types';
import { conversationsStore } from './conversations.svelte';
import { preferencesStore } from './preferences.svelte';

export interface PendingMessage {
  role: 'assistant';
  content: string;
  model: string;
}

function createChatStore() {
  let messages = $state<Message[]>([]);
  let pending = $state<PendingMessage | null>(null);
  let streaming = $state(false);
  let loadingMessages = $state(false);
  let error = $state<string | null>(null);
  let activeConversationId = $state<string | null>(null);
  let loadGeneration = 0;
  let activeStream: {
    id: string;
    conversationId: string;
    controller: AbortController;
    userMessage: Message;
    accepted: boolean;
    stopRequested: boolean;
  } | null = null;

  const allMessages = $derived<Array<Message | PendingMessage>>(
    pending ? [...messages, pending] : messages,
  );

  function setActiveConversation(convId: string | null) {
    if (activeConversationId === convId) return;
    loadGeneration += 1;
    if (activeStream?.conversationId !== convId) {
      activeStream?.controller.abort();
      activeStream = null;
      streaming = false;
    }
    activeConversationId = convId;
    messages = [];
    pending = null;
    loadingMessages = false;
    error = null;
  }

  async function loadMessages(convId: string) {
    if (activeConversationId !== convId) setActiveConversation(convId);
    const generation = ++loadGeneration;
    loadingMessages = true;
    error = null;
    try {
      const loaded = await api.conversations.messages(convId);
      if (activeConversationId === convId && generation === loadGeneration) messages = loaded;
    } catch (e) {
      if (activeConversationId === convId && generation === loadGeneration) {
        error = (e as Error).message;
        messages = [];
      }
    } finally {
      if (activeConversationId === convId && generation === loadGeneration) loadingMessages = false;
    }
  }

  async function reconcileMessages(convId: string, optimistic: Message, accepted: boolean) {
    // Give the server's abort handler a brief chance to persist a partial response.
    if (activeStream?.controller.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    try {
      const authoritative = await api.conversations.messages(convId);
      if (activeConversationId !== convId) return;
      if (!authoritative.some(message => message.id === optimistic.id) && !accepted) {
        messages = [...authoritative, { ...optimistic, delivery_status: 'failed' }];
      } else {
        messages = authoritative;
      }
    } catch (reconcileError) {
      if (activeConversationId !== convId) return;
      messages = messages.map(message => message.id === optimistic.id
        ? { ...message, delivery_status: accepted ? 'uncertain' : 'failed' }
        : message);
      error ??= `Could not verify the saved messages: ${(reconcileError as Error).message}`;
    }
  }

  async function send(payload: ChatPayload) {
    if (activeStream) return;
    const convId = payload.conversation_id;
    if (!convId) {
      error = 'A conversation must be created before sending a message.';
      return;
    }
    if (activeConversationId !== convId) setActiveConversation(convId);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const userMsg: Message = {
      id: userMessageId,
      conversation_id: convId,
      role: 'user',
      content: payload.new_user_message.content,
      model: null,
      status: null,
      timestamp: Date.now(),
      edited_at: null,
      delivery_status: 'sending',
    };
    messages = [...messages, userMsg];

    streaming = true;
    error = null;
    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    activeStream = {
      id: operationId,
      conversationId: convId,
      controller,
      userMessage: userMsg,
      accepted: false,
      stopRequested: false,
    };
    pending = { role: 'assistant', content: '', model: payload.model };
    let terminalEvent = false;

    try {
      await streamChat({
        ...payload,
        assistant_message_id: assistantMessageId,
        new_user_message: { ...payload.new_user_message, id: userMessageId },
      }, controller.signal, (event) => {
        if (activeStream?.id !== operationId) return;
        if (event.type === 'accepted') {
          activeStream.accepted = true;
          messages = messages.map(message => message.id === userMessageId ? event.user_message : message);
        } else if (event.type === 'delta') {
          if (pending) pending.content += event.content;
        } else if (event.type === 'done') {
          terminalEvent = true;
          if (event.message) messages = [...messages, event.message];
          pending = null;
          playCompletionSound(
            preferencesStore.soundEnabled,
            preferencesStore.soundVolume,
          );
        } else if (event.type === 'title') {
          conversationsStore.updateTitle(convId, event.title);
        } else if (event.type === 'error') {
          terminalEvent = true;
          error = event.message;
          pending = null;
        }
      });
    } catch (e) {
      if (activeConversationId === convId && activeStream?.id === operationId) {
        if ((e as Error).name === 'AbortError') {
          if (!activeStream.stopRequested) error = 'Response interrupted while leaving the conversation.';
        } else {
          error = (e as Error).message;
        }
        pending = null;
      }
    } finally {
      const accepted = activeStream?.id === operationId ? activeStream.accepted : false;
      const operationIsCurrent = activeStream?.id === operationId;
      await reconcileMessages(convId, userMsg, accepted);
      if (operationIsCurrent && activeStream?.id === operationId) {
        if (!terminalEvent && !controller.signal.aborted) {
          error ??= 'The connection closed before completion; saved messages were reloaded.';
        }
        activeStream = null;
        streaming = false;
        pending = null;
      }
    }
  }

  function stop() {
    if (activeStream) {
      activeStream.stopRequested = true;
      activeStream.controller.abort();
    }
  }

  async function editUserMessage(convId: string, msgId: string) {
    await api.conversations.deleteMessage(convId, msgId);
    await loadMessages(convId);
  }

  async function editAssistantMessage(convId: string, msgId: string, newContent: string) {
    const updated = await api.conversations.editMessage(convId, msgId, newContent);
    messages = messages.map(m => m.id === msgId ? updated : m);
  }

  async function deleteMessage(convId: string, msgId: string) {
    await api.conversations.deleteMessage(convId, msgId);
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx !== -1) messages = messages.slice(0, idx);
  }

  function clear() {
    setActiveConversation(null);
  }

  return {
    get messages() { return messages; },
    get pending() { return pending; },
    get streaming() { return streaming; },
    get loadingMessages() { return loadingMessages; },
    get error() { return error; },
    get allMessages() { return allMessages; },
    get activeConversationId() { return activeConversationId; },
    loadMessages, send, stop, editUserMessage, editAssistantMessage, deleteMessage, clear, setActiveConversation,
  };
}

export const chatStore = createChatStore();
