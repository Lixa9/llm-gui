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
  import { promptsStore } from '../../stores/prompts.svelte';
  import { preferencesStore } from '../../stores/preferences.svelte';
  import type { Message, ChatPayload } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';

  interface Props { conversationId: string | null; }
  let { conversationId }: Props = $props();

  let editingMessage = $state<Message | null>(null);
  let selectedModel = $state('');
  // '__preset__' = system prompt comes from the active preset; '' = none; else = library prompt ID
  let selectedPromptId = $state('');
  let selectedPresetId = $state('');
  let skipNextLoad = false;

  // Resolved system prompt values passed to Composer
  const systemPromptText = $derived(
    selectedPromptId === '__preset__'
      ? (modelsStore.presets.find(p => p.id === selectedPresetId)?.system_prompt ?? '')
      : selectedPromptId
        ? (promptsStore.prompts.find(p => p.id === selectedPromptId)?.content ?? '')
        : ''
  );
  const systemPromptId = $derived(
    selectedPromptId && selectedPromptId !== '__preset__' ? selectedPromptId : undefined
  );

  // Label shown in PromptPicker when a preset is active
  const activePresetLabel = $derived(
    selectedPresetId
      ? (modelsStore.presets.find(p => p.id === selectedPresetId)?.name ?? '')
      : undefined
  );

  // Load/restore settings when switching to an existing conversation.
  // skipNextLoad is true when we just created the conversation — settings are
  // already correct from the new-chat state, no need to read them back.
  $effect(() => {
    if (!conversationId) {
      chatStore.clear();
      return;
    }
    if (!skipNextLoad) {
      const conv = conversationsStore.list.find(c => c.id === conversationId);
      if (conv) {
        selectedModel = conv.model_id ?? preferencesStore.defaultModelId ?? modelsStore.models[0]?.id ?? '';
        selectedPresetId = conv.preset_id ?? '';
        selectedPromptId = conv.preset_id ? '__preset__' : (conv.system_prompt_id ?? '');
      }
      chatStore.loadMessages(conversationId);
    }
    skipNextLoad = false;
  });

  // Apply default preset on new chat screen — re-runs whenever defaults or presets load
  $effect(() => {
    if (conversationId) return;
    const defaultPresetId = preferencesStore.defaultPresetId;
    const presets = modelsStore.presets;
    if (defaultPresetId && presets.length > 0) {
      const preset = presets.find(p => p.id === defaultPresetId);
      if (preset) {
        selectedPresetId = defaultPresetId;
        selectedModel = preset.base_model_id;
        selectedPromptId = '__preset__';
        return;
      }
    }
    selectedPresetId = '';
    selectedPromptId = '';
  });

  // Fallback: set model when none is selected yet
  $effect(() => {
    if (!selectedModel) {
      if (preferencesStore.defaultModelId) selectedModel = preferencesStore.defaultModelId;
      else if (modelsStore.models.length > 0) selectedModel = modelsStore.models[0].id;
    }
  });

  function saveConvSettings() {
    if (!conversationId) return;
    const preset = selectedPresetId ? modelsStore.presets.find(p => p.id === selectedPresetId) : null;
    conversationsStore.update(conversationId, {
      model_id: selectedModel,
      preset_id: selectedPresetId || null,
      system_prompt_id: (!selectedPresetId && selectedPromptId && selectedPromptId !== '__preset__') ? selectedPromptId : null,
      custom_system_prompt: preset?.system_prompt || null,
    });
  }

  function handleModelChange(newModel: string) {
    selectedModel = newModel;
    if (selectedPresetId) {
      const preset = modelsStore.presets.find(p => p.id === selectedPresetId);
      if (preset && preset.base_model_id !== newModel) {
        selectedPresetId = '';
        if (selectedPromptId === '__preset__') selectedPromptId = '';
      }
    }
    saveConvSettings();
  }

  function handlePresetChange(presetId: string) {
    selectedPresetId = presetId;
    if (presetId) {
      const preset = modelsStore.presets.find(p => p.id === presetId);
      if (preset) {
        selectedModel = preset.base_model_id;
        selectedPromptId = '__preset__';
      }
    } else {
      selectedPromptId = '';
    }
    saveConvSettings();
  }

  function handlePromptChange(promptId: string) {
    selectedPromptId = promptId;
    if (promptId !== '__preset__' && selectedPresetId) {
      selectedPresetId = '';
    }
    saveConvSettings();
  }

  async function handleSend(payload: ChatPayload) {
    let convId = conversationId;
    if (!convId) {
      const preset = selectedPresetId ? modelsStore.presets.find(p => p.id === selectedPresetId) : null;
      const conv = await conversationsStore.create({
        model_id: payload.model,
        preset_id: selectedPresetId || undefined,
        system_prompt_id: payload.system_prompt_id,
        custom_system_prompt: preset?.system_prompt || payload.system_prompt || undefined,
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
          system_prompt: systemPromptText || undefined,
          system_prompt_id: systemPromptId,
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
      system_prompt: systemPromptText || undefined,
      system_prompt_id: systemPromptId,
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
      <span class="picker-label">Prompt</span>
      <PromptPicker bind:value={selectedPromptId} onchange={handlePromptChange} presetLabel={activePresetLabel} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Model</span>
      <ModelPicker bind:value={selectedModel} onchange={handleModelChange} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Preset</span>
      <PresetPicker bind:value={selectedPresetId} onchange={handlePresetChange} />
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
    {systemPromptText}
    {systemPromptId}
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
