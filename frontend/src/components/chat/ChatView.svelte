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
  import { navigateTo } from '$lib/router';

  interface Props { conversationId: string | null; }
  let { conversationId }: Props = $props();

  let editingMessage = $state<Message | null>(null);
  let composerExpanded = $state(false);

  // Override state — null means "use derived/auto value"
  let _presetId = $state<string | null>(null);
  let _modelId = $state<string | null>(null);
  let _promptId = $state<string | null>(null);
  let skipNextLoad = false;

  // Derived picker values — always correct regardless of async load order
  const selectedPresetId = $derived.by((): string => {
    if (_presetId !== null) return _presetId;
    if (!conversationId) {
      const defId = preferencesStore.defaultPresetId;
      if (defId && modelsStore.presets.some(p => p.id === defId)) return defId;
      return '';
    }
    return conversationsStore.list.find(c => c.id === conversationId)?.preset_id ?? '';
  });

  const selectedModel = $derived.by((): string => {
    if (_modelId !== null) return _modelId;
    if (selectedPresetId) {
      const preset = modelsStore.presets.find(p => p.id === selectedPresetId);
      if (preset) return preset.base_model_id;
    }
    if (conversationId) {
      const conv = conversationsStore.list.find(c => c.id === conversationId);
      if (conv?.model_id) return conv.model_id;
    }
    return preferencesStore.defaultModelId ?? modelsStore.models[0]?.id ?? '';
  });

  const selectedPromptId = $derived.by((): string => {
    if (_promptId !== null) return _promptId;
    if (selectedPresetId) return '__preset__';
    if (!conversationId) return '';
    return conversationsStore.list.find(c => c.id === conversationId)?.system_prompt_id ?? '';
  });

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

  const activePresetLabel = $derived(
    selectedPresetId
      ? (modelsStore.presets.find(p => p.id === selectedPresetId)?.name ?? '')
      : undefined
  );

  // Reset overrides when conversation changes so $derived reads from the new context
  $effect(() => {
    const cid = conversationId;
    _presetId = null;
    _modelId = null;
    _promptId = null;
    if (!cid) {
      chatStore.setActiveConversation(null);
      return;
    }
    chatStore.setActiveConversation(cid);
    if (!skipNextLoad) {
      chatStore.loadMessages(cid);
    }
    skipNextLoad = false;
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
    if (selectedPresetId) {
      const preset = modelsStore.presets.find(p => p.id === selectedPresetId);
      if (preset && preset.base_model_id !== newModel) {
        _presetId = '';
        _promptId = '';
      }
    }
    _modelId = newModel;
    saveConvSettings();
  }

  function handlePresetChange(presetId: string) {
    _presetId = presetId;
    _modelId = null;
    _promptId = null;
    saveConvSettings();
  }

  function handlePromptChange(promptId: string) {
    if (promptId !== '__preset__' && selectedPresetId) {
      if (_modelId === null) _modelId = selectedModel;
      _presetId = '';
    }
    _promptId = promptId;
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
        folder_id: conversationsStore.activeFolderId ?? undefined,
      });
      convId = conv.id;
      conversationsStore.setActive(convId);
      chatStore.setActiveConversation(convId);
      skipNextLoad = true;
      navigateTo('chat', convId);
    }
    await chatStore.send({ ...payload, conversation_id: convId });
  }

  async function handleEdit(msg: Message, newContent: string) {
    if (!conversationId) return;
    try {
      if (msg.role === 'user') {
        await chatStore.editUserMessage(conversationId, msg.id);
        const messages = chatStore.messages;
        const idx = messages.findIndex(m => m.id === msg.id);
        const history = idx >= 0 ? messages.slice(0, idx) : messages;
        const payload: ChatPayload = {
          conversation_id: conversationId,
          model: messages[idx]?.model ?? selectedModel,
          system_prompt: systemPromptText || undefined,
          system_prompt_id: systemPromptId,
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
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    await chatStore.regenerate({
      conversation_id: conversationId,
      model: msg.model ?? history.find(m => m.model)?.model ?? selectedModel,
      system_prompt: systemPromptText || undefined,
      assistant_message_id: msg.id,
    });
  }
</script>

<div class="chat-view">
  <div class="chat-toolbar">
    <div class="picker-group">
      <span class="picker-label">Prompt</span>
      <PromptPicker value={selectedPromptId} onchange={handlePromptChange} presetLabel={activePresetLabel} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Model</span>
      <ModelPicker value={selectedModel} onchange={handleModelChange} />
    </div>
    <div class="picker-group">
      <span class="picker-label">Preset</span>
      <PresetPicker value={selectedPresetId} onchange={handlePresetChange} />
    </div>
  </div>

  {#if !composerExpanded}
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
  {/if}

  <Composer
    {conversationId}
    {selectedModel}
    {systemPromptText}
    {systemPromptId}
    streaming={chatStore.streaming}
    onSend={handleSend}
    onStop={chatStore.stop}
    bind:expanded={composerExpanded}
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
