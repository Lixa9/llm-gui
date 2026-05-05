<script lang="ts">
  import ModelPicker from './ModelPicker.svelte';
  import PromptPicker from './PromptPicker.svelte';
  import PresetPicker from './PresetPicker.svelte';
  import FileAttachment from './FileAttachment.svelte';
  import { chatStore } from '../../stores/chat.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import { promptsStore } from '../../stores/prompts.svelte';
  import { preferencesStore } from '../../stores/preferences.svelte';
  import type { MessageContentPart, ChatPayload, Attachment } from '$lib/types';

  interface Props {
    conversationId: string | null;
    onSend: (payload: ChatPayload) => void;
    onStop: () => void;
    streaming: boolean;
  }
  let { conversationId, onSend, onStop, streaming }: Props = $props();

  let text = $state('');
  let selectedModel = $state('');
  let selectedPromptId = $state('');
  let attachments = $state<Attachment[]>([]);

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
    if (preset) {
      selectedModel = preset.base_model_id;
    }
  }

  function buildContent(): MessageContentPart[] {
    const parts: MessageContentPart[] = [];
    for (const att of attachments) {
      if (att.type === 'image' || att.type === 'file') {
        parts.push({ type: 'image_url', image_url: { url: att.url } });
      } else {
        parts.push({ type: 'text', text: `[File: ${att.name}]\n${att.content}` });
      }
    }
    if (text.trim()) {
      parts.push({ type: 'text', text: text.trim() });
    }
    return parts;
  }

  function send() {
    const content = buildContent();
    if (content.length === 0 || !selectedModel) return;

    const systemPrompt = selectedPromptId
      ? promptsStore.prompts.find(p => p.id === selectedPromptId)?.content
      : undefined;

    const payload: ChatPayload = {
      conversation_id: conversationId,
      model: selectedModel,
      system_prompt: systemPrompt,
      system_prompt_id: selectedPromptId || undefined,
      messages: chatStore.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        tool_calls: m.tool_calls ?? undefined,
        tool_results: m.tool_results ?? undefined,
      })),
      new_user_message: { content },
    };

    text = '';
    attachments = [];
    onSend(payload);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    }
  }
</script>

<div class="composer">
  <div class="composer-pickers">
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

  <div class="composer-input-row">
    <FileAttachment
      {attachments}
      onAdd={(a) => attachments = [...attachments, a]}
      onRemove={(name) => attachments = attachments.filter(a => a.name !== name)}
    />
    <textarea
      class="composer-textarea"
      bind:value={text}
      placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
      rows={1}
      onkeydown={handleKeydown}
      disabled={streaming}
    ></textarea>
    {#if streaming}
      <button class="send-btn stop-btn" onclick={onStop} title="Stop generation">⏹ Stop</button>
    {:else}
      <button class="send-btn" onclick={send} disabled={!text.trim() && attachments.length === 0} title="Send">
        ↑ Send
      </button>
    {/if}
  </div>
</div>

<style>
  .composer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 10px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }

  .composer-pickers {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .picker-group {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .picker-label { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

  .composer-input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .composer-textarea {
    flex: 1;
    padding: 9px 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-sans);
    line-height: 1.5;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
    min-height: 40px;
    max-height: 240px;
    overflow-y: auto;
  }
  .composer-textarea:focus { border-color: var(--accent); }
  .composer-textarea:disabled { opacity: 0.6; }

  .send-btn {
    padding: 9px 16px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s, opacity 0.1s;
    flex-shrink: 0;
    height: 40px;
  }
  .send-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stop-btn { background: var(--danger); }
  .stop-btn:hover { background: var(--danger-hover); }
</style>
