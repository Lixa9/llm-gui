<script lang="ts">
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import EditMessageModal from './EditMessageModal.svelte';
  import { chatStore } from '../../stores/chat.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';
  import type { Message, ChatPayload } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';

  interface Props { conversationId: string | null; }
  let { conversationId }: Props = $props();

  let editingMessage = $state<Message | null>(null);

  $effect(() => {
    if (conversationId) {
      chatStore.loadMessages(conversationId);
    } else {
      chatStore.clear();
    }
  });

  async function handleSend(payload: ChatPayload) {
    let convId = conversationId;
    if (!convId) {
      // Create conversation on first message
      const conv = await conversationsStore.create({
        model_id: payload.model,
        system_prompt_id: payload.system_prompt_id,
        custom_system_prompt: payload.system_prompt,
      });
      convId = conv.id;
      conversationsStore.setActive(convId);
      window.location.hash = `#/chat/${convId}`;
    }
    await chatStore.send({ ...payload, conversation_id: convId });
  }

  async function handleEdit(msg: Message, newContent: string) {
    if (!conversationId) return;
    try {
      if (msg.role === 'user') {
        await chatStore.editUserMessage(conversationId, msg.id, newContent);
        // Auto-regenerate: send the conversation up to this point
        const messages = chatStore.messages;
        const idx = messages.findIndex(m => m.id === msg.id);
        const history = idx >= 0 ? messages.slice(0, idx) : messages;
        const payload: ChatPayload = {
          conversation_id: conversationId,
          model: messages[idx]?.model ?? '',
          messages: history.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          new_user_message: { content: [{ type: 'text', text: newContent }] },
        };
        await chatStore.send(payload);
      } else {
        await chatStore.editAssistantMessage(conversationId, msg.id, newContent);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function handleRegenerate(msg: Message) {
    if (!conversationId) return;
    const idx = chatStore.messages.findIndex(m => m.id === msg.id);
    if (idx < 0) return;
    const history = chatStore.messages.slice(0, idx);
    // Delete from this message onward, then re-send
    await chatStore.deleteMessage(conversationId, msg.id);
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) return;

    const payload: ChatPayload = {
      conversation_id: conversationId,
      model: msg.model ?? history.find(m => m.model)?.model ?? '',
      messages: history.slice(0, history.indexOf(lastUser)).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      new_user_message: { content: lastUser.content },
    };
    await chatStore.send(payload);
  }
</script>

<div class="chat-view">
  {#if conversationId}
    <MessageList
      {conversationId}
      onEdit={(msg) => editingMessage = msg}
      onRegenerate={handleRegenerate}
    />
  {:else}
    <div class="chat-welcome">
      <div class="welcome-icon">✦</div>
      <h2 class="welcome-title">Start a conversation</h2>
      <p class="welcome-sub">Select a model and type a message below.</p>
    </div>
  {/if}

  <Composer
    {conversationId}
    streaming={chatStore.streaming}
    onSend={handleSend}
    onStop={chatStore.stop}
  />
</div>

<EditMessageModal
  open={editingMessage !== null}
  message={editingMessage}
  onclose={() => editingMessage = null}
  onsave={(id, content, role) => {
    const msg = chatStore.messages.find(m => m.id === id);
    if (msg) handleEdit(msg, content);
  }}
/>

<style>
  .chat-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .chat-welcome {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-muted);
  }
  .welcome-icon { font-size: 40px; opacity: 0.3; }
  .welcome-title { font-size: 20px; color: var(--text-secondary); font-weight: 500; }
  .welcome-sub { font-size: 14px; }
</style>
