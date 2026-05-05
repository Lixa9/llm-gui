<script lang="ts">
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import EditMessageModal from './EditMessageModal.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import PromptPicker from './PromptPicker.svelte';
  import PresetPicker from './PresetPicker.svelte';
  import { chatStore } from '../../stores/chat.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import { preferencesStore } from '../../stores/preferences.svelte';
  import type { Message, ChatPayload } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';

  interface Props { conversationId: string | null; }
  let { conversationId }: Props = $props();

  let editingMessage = $state<Message | null>(null);
  let selectedModel = $state('');
  let selectedPromptId = $state('');
  let skipNextLoad = false;

  // Set default model once models are available
  $effect(() => {
    if (!selectedModel && preferencesStore.defaultModelId) {
      selectedModel = preferencesStore.defaultModelId;
    } else if (!selectedModel && modelsStore.models.length > 0) {
      selectedModel = modelsStore.models[0].id;
    }
  });

  function handlePresetSelect(presetId: string) {
    if (!presetId) return;
    const preset = modelsStore.presets.find(p => p.id === presetId);
    if (preset) selectedModel = preset.base_model_id;
  }

  $effect(() => {
    if (conversationId) {
      if (skipNextLoad) { skipNextLoad = false; return; }
      chatStore.loadMessages(conversationId);
    } else {
      chatStore.clear();
    }
  });

  async function handleSend(payload: ChatPayload) {
    let convId = conversationId;
    if (!convId) {
      const conv = await conversationsStore.create({
        model_id: payload.model,
        system_prompt_id: payload.system_prompt_id,
        custom_system_prompt: payload.system_prompt,
      });
      convId = conv.id;
      conversationsStore.setActive(convId);
      skipNextLoad = true;
      window.location.hash = `#/chat/${convId}`;
    }
    await chatStore.send({ ...payload, conversation_id: convId });
  }

  async function handleEdit(msg: Message, newContent: string) {
    if (!conversationId) return;
    try {
      if (msg.role === 'user') {
        await chatStore.editUserMessage(conversationId, msg.id, newContent);
        const messages = chatStore.messages;
        const idx = messages.findIndex(m => m.id === msg.id);
        const history = idx >= 0 ? messages.slice(0, idx) : messages;
        const payload: ChatPayload = {
          conversation_id: conversationId,
          model: messages[idx]?.model ?? selectedModel,
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
    await chatStore.deleteMessage(conversationId, msg.id);
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) return;

    const payload: ChatPayload = {
      conversation_id: conversationId,
      model: msg.model ?? history.find(m => m.model)?.model ?? selectedModel,
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
  <div class="chat-toolbar">
    <div class="picker-group">
      <span class="picker-label">Model</span>
      <ModelPicker bind:value={selectedModel} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Prompt</span>
      <PromptPicker bind:value={selectedPromptId} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Preset</span>
      <PresetPicker onselect={handlePresetSelect} />
    </div>
  </div>

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
      <p class="welcome-sub">Select a model above and type a message below.</p>
    </div>
  {/if}

  <Composer
    {conversationId}
    {selectedModel}
    {selectedPromptId}
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

  .chat-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .picker-group {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .picker-label {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
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
