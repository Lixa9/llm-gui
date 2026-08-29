import { streamChat } from '$lib/sse';
import { api } from '$lib/api';
import { playCompletionSound } from '$lib/audio';
import type { Message, ChatPayload, RegenerateChatPayload, ChatSendResult, ChatGeneration } from '$lib/types';
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
  let activeGenerationId = $state<string | null>(null);
  let loadGeneration = 0;
  let pollGeneration = 0;
  let pollingGenerationId: string | null = null;
  let activeStream: {
    id: string;
    conversationId: string;
    controller: AbortController;
    userMessage: Message;
    accepted: boolean;
    stopRequested: boolean;
    generationId: string;
    acceptedReady: Promise<boolean>;
    resolveAccepted: (accepted: boolean) => void;
  } | null = null;

  const allMessages = $derived<Array<Message | PendingMessage>>(
    pending ? [...messages, pending] : messages,
  );

  function setActiveConversation(convId: string | null) {
    if (activeConversationId === convId) return;
    loadGeneration += 1;
    pollGeneration += 1;
    pollingGenerationId = null;
    if (activeStream?.conversationId !== convId) {
      activeStream?.controller.abort();
      activeStream = null;
      streaming = false;
    }
    activeConversationId = convId;
    activeGenerationId = null;
    messages = [];
    pending = null;
    loadingMessages = false;
    error = null;
  }

  function upsertMessage(message: Message): void {
    const index = messages.findIndex(existing => existing.id === message.id);
    if (index < 0) messages = [...messages, message].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    else messages = messages.map(existing => existing.id === message.id ? message : existing);
  }

  function applyGeneration(generation: ChatGeneration): boolean {
    if (activeConversationId !== generation.conversation_id) return true;
    if (generation.message) upsertMessage(generation.message);
    const terminal = !['queued', 'running'].includes(generation.status);
    if (!terminal) {
      activeGenerationId = generation.id;
      streaming = true;
      pending = null;
      return false;
    }

    if (activeGenerationId === generation.id) activeGenerationId = null;
    if (pollingGenerationId === generation.id) {
      pollingGenerationId = null;
      pollGeneration += 1;
    }
    streaming = false;
    pending = null;
    if (generation.status === 'timed_out') error = generation.last_error ?? 'Generation timed out';
    else if (generation.status === 'failed') error = generation.last_error ?? 'Generation failed';
    else error = null;
    return true;
  }

  function startGenerationPolling(generationId: string, convId: string): void {
    if (pollingGenerationId === generationId) return;
    pollingGenerationId = generationId;
    const token = ++pollGeneration;
    void (async () => {
      let failures = 0;
      while (activeConversationId === convId && token === pollGeneration) {
        try {
          const generation = await api.chat.generation(generationId);
          failures = 0;
          if (error?.startsWith('Could not refresh the running response:')) error = null;
          if (activeConversationId !== convId || token !== pollGeneration) return;
          if (applyGeneration(generation)) {
            if (generation.status === 'done') playCompletionSound(preferencesStore.soundEnabled, preferencesStore.soundVolume);
            void conversationsStore.refreshUntilTitle(convId).catch(() => {});
            return;
          }
        } catch (pollError) {
          if (activeConversationId === convId && token === pollGeneration) {
            if ((pollError as { status?: number }).status === 404) {
              pollingGenerationId = null;
              activeGenerationId = null;
              streaming = false;
              return;
            }
            failures += 1;
            error = `Could not refresh the running response: ${(pollError as Error).message}`;
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(10_000, failures * 1_000)));
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (token === pollGeneration) pollingGenerationId = null;
    })();
  }

  function syncGenerationState(convId: string, loaded: Message[]): void {
    const running = [...loaded].reverse().find(message => message.role === 'assistant' && message.status === 'streaming');
    if (running) {
      activeGenerationId = running.id;
      streaming = true;
      pending = null;
      startGenerationPolling(running.id, convId);
    } else if (!activeStream || activeStream.conversationId !== convId) {
      activeGenerationId = null;
      streaming = false;
    }
  }

  async function loadMessages(convId: string) {
    if (activeConversationId !== convId) setActiveConversation(convId);
    const generation = ++loadGeneration;
    loadingMessages = true;
    error = null;
    try {
      const loaded = await api.conversations.messages(convId);
      if (activeConversationId === convId && generation === loadGeneration) {
        messages = loaded;
        syncGenerationState(convId, loaded);
      }
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
      syncGenerationState(convId, authoritative);
    } catch (reconcileError) {
      if (activeConversationId !== convId) return;
      messages = messages.map(message => message.id === optimistic.id
        ? { ...message, delivery_status: accepted ? 'uncertain' : 'failed' }
        : message);
      error ??= `Could not verify the saved messages: ${(reconcileError as Error).message}`;
    }
  }

  async function send(payload: ChatPayload): Promise<ChatSendResult> {
    if (activeStream || activeGenerationId) return { accepted: false };
    const convId = payload.conversation_id;
    if (!convId) {
      error = 'A conversation must be created before sending a message.';
      return { accepted: false };
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
    let resolveAccepted!: (accepted: boolean) => void;
    const acceptedReady = new Promise<boolean>(resolve => { resolveAccepted = resolve; });
    activeStream = {
      id: operationId,
      conversationId: convId,
      controller,
      userMessage: userMsg,
      accepted: false,
      stopRequested: false,
      generationId: assistantMessageId,
      acceptedReady,
      resolveAccepted,
    };
    activeGenerationId = assistantMessageId;
    pending = { role: 'assistant', content: '', model: payload.model };
    let terminalEvent = false;
    let acceptedByServer = false;

    try {
      await streamChat({
        ...payload,
        assistant_message_id: assistantMessageId,
        new_user_message: { ...payload.new_user_message, id: userMessageId },
      }, controller.signal, (event) => {
        if (activeStream?.id !== operationId) return;
        if (event.type === 'accepted') {
          acceptedByServer = true;
          activeStream.accepted = true;
          activeStream.resolveAccepted(true);
          activeStream.generationId = event.assistant_message_id;
          activeGenerationId = event.assistant_message_id;
          messages = messages.map(message => message.id === userMessageId ? event.user_message : message);
        } else if (event.type === 'delta') {
          if (pending) pending.content += event.content;
        } else if (event.type === 'done') {
          terminalEvent = true;
          if (event.message) messages = [...messages, event.message];
          pending = null;
          activeGenerationId = null;
          playCompletionSound(
            preferencesStore.soundEnabled,
            preferencesStore.soundVolume,
          );
        } else if (event.type === 'cancelled') {
          terminalEvent = true;
          if (event.message) upsertMessage(event.message);
          activeGenerationId = null;
          pending = null;
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
      resolveAccepted(acceptedByServer);
      await reconcileMessages(convId, userMsg, accepted);
      if (operationIsCurrent && activeStream?.id === operationId) {
        if (!terminalEvent && !controller.signal.aborted) {
          error ??= 'The connection closed before completion; saved messages were reloaded.';
        }
        activeStream = null;
        streaming = false;
        pending = null;
      }
      if (activeConversationId === convId) syncGenerationState(convId, messages);
      void conversationsStore.refreshUntilTitle(convId).catch(() => {});
    }
    return { accepted: acceptedByServer };
  }

  async function regenerate(payload: RegenerateChatPayload) {
    if (activeStream || activeGenerationId) return;
    if (activeConversationId !== payload.conversation_id) setActiveConversation(payload.conversation_id);
    const assistantIndex = messages.findIndex(message => message.id === payload.assistant_message_id);
    const retainedUser = assistantIndex > 0 ? messages[assistantIndex - 1] : undefined;
    if (!retainedUser || retainedUser.role !== 'user') {
      error = 'The response cannot be regenerated because its user message is missing.';
      return;
    }
    // Regeneration replaces this response and everything after it. Remove the
    // stale tail optimistically; reconciliation restores it if the request is
    // rejected before the server applies the replacement.
    messages = messages.slice(0, assistantIndex);

    streaming = true;
    error = null;
    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    let resolveAccepted!: (accepted: boolean) => void;
    const acceptedReady = new Promise<boolean>(resolve => { resolveAccepted = resolve; });
    activeStream = {
      id: operationId,
      conversationId: payload.conversation_id,
      controller,
      userMessage: retainedUser,
      accepted: false,
      stopRequested: false,
      generationId: '',
      acceptedReady,
      resolveAccepted,
    };
    pending = { role: 'assistant', content: '', model: payload.model };
    let terminalEvent = false;
    let acceptedByServer = false;

    try {
      await streamChat(payload, controller.signal, (event) => {
        if (activeStream?.id !== operationId) return;
        if (event.type === 'accepted') {
          acceptedByServer = true;
          activeStream.accepted = true;
          activeStream.resolveAccepted(true);
          activeStream.generationId = event.assistant_message_id;
          activeGenerationId = event.assistant_message_id;
          messages = messages.map(message => message.id === event.user_message.id ? event.user_message : message);
        } else if (event.type === 'delta') {
          if (pending) pending.content += event.content;
        } else if (event.type === 'done') {
          terminalEvent = true;
          if (event.message) messages = [...messages, event.message];
          pending = null;
          activeGenerationId = null;
          playCompletionSound(preferencesStore.soundEnabled, preferencesStore.soundVolume);
        } else if (event.type === 'cancelled') {
          terminalEvent = true;
          if (event.message) upsertMessage(event.message);
          activeGenerationId = null;
          pending = null;
        } else if (event.type === 'error') {
          terminalEvent = true;
          error = event.message;
          pending = null;
        }
      }, '/api/chat/regenerate');
    } catch (e) {
      if (activeConversationId === payload.conversation_id && activeStream?.id === operationId) {
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
      resolveAccepted(acceptedByServer);
      await reconcileMessages(payload.conversation_id, retainedUser, accepted);
      if (operationIsCurrent && activeStream?.id === operationId) {
        if (!terminalEvent && !controller.signal.aborted) error ??= 'The connection closed before completion; saved messages were reloaded.';
        activeStream = null;
        streaming = false;
        pending = null;
      }
      if (activeConversationId === payload.conversation_id) syncGenerationState(payload.conversation_id, messages);
      void conversationsStore.refreshUntilTitle(payload.conversation_id).catch(() => {});
    }
  }

  async function stop() {
    const stream = activeStream;
    if (stream && !stream.accepted) {
      stream.stopRequested = true;
      if (!await stream.acceptedReady) return;
    }
    const generationId = activeGenerationId ?? stream?.generationId;
    if (!generationId) return;
    if (stream) stream.stopRequested = true;
    error = null;
    try {
      const generation = await api.chat.cancel(generationId);
      applyGeneration(generation);
      activeStream?.controller.abort();
      pollGeneration += 1;
      pollingGenerationId = null;
    } catch (stopError) {
      if (activeStream) activeStream.stopRequested = false;
      error = `Could not stop generation: ${(stopError as Error).message}`;
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
    if (activeGenerationId) {
      pollGeneration += 1;
      pollingGenerationId = null;
      activeGenerationId = null;
      activeStream?.controller.abort();
      activeStream = null;
      streaming = false;
      pending = null;
    }
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
    get activeGenerationId() { return activeGenerationId; },
    loadMessages, send, regenerate, stop, editUserMessage, editAssistantMessage, deleteMessage, clear, setActiveConversation,
  };
}

export const chatStore = createChatStore();
