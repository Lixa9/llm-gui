<script lang="ts">
  import { chatStore } from '../../stores/chat.svelte';
  import { api } from '$lib/api';
  import type { ChatPayload, UploadResult } from '$lib/types';

  interface Props {
    conversationId: string | null;
    selectedModel: string;
    systemPromptText: string;
    systemPromptId: string | undefined;
    onSend: (payload: ChatPayload) => void;
    onStop: () => void;
    streaming: boolean;
    expanded?: boolean;
  }
  let { conversationId, selectedModel, systemPromptText, systemPromptId, onSend, onStop, streaming, expanded = $bindable(false) }: Props = $props();

  interface PendingAttachment {
    localUrl: string;
    filename: string;
    status: 'uploading' | 'ready' | 'error';
    result?: UploadResult;
    errorMsg?: string;
  }

  let text = $state('');
  let pendingAttachments = $state<PendingAttachment[]>([]);
  let fileInputEl: HTMLInputElement;

  async function onFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      const localUrl = URL.createObjectURL(file);
      const attachment: PendingAttachment = { localUrl, filename: file.name, status: 'uploading' };
      pendingAttachments = [...pendingAttachments, attachment];
      const idx = pendingAttachments.length - 1;
      try {
        const result = await api.uploads.upload(file);
        pendingAttachments = pendingAttachments.map((a, i) =>
          i === idx ? { ...a, status: 'ready', result } : a
        );
      } catch (err) {
        pendingAttachments = pendingAttachments.map((a, i) =>
          i === idx ? { ...a, status: 'error', errorMsg: (err as Error).message } : a
        );
      }
    }
  }

  function removeAttachment(idx: number) {
    const a = pendingAttachments[idx];
    URL.revokeObjectURL(a.localUrl);
    pendingAttachments = pendingAttachments.filter((_, i) => i !== idx);
  }

  function send() {
    const trimmed = text.trim();
    const readyAttachments = pendingAttachments.filter(a => a.status === 'ready' && a.result);
    if ((!trimmed && readyAttachments.length === 0) || !selectedModel) return;

    const imageParts = readyAttachments.map(a => ({
      type: 'image_url' as const,
      image_url: { url: a.result!.url },
      _filename: a.result!.filename,
    }));

    const textParts = trimmed ? [{ type: 'text' as const, text: trimmed }] : [];
    const contentParts = [...imageParts, ...textParts];

    const payload: ChatPayload = {
      conversation_id: conversationId,
      model: selectedModel,
      system_prompt: systemPromptText || undefined,
      system_prompt_id: systemPromptId,
      messages: chatStore.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        tool_calls: m.tool_calls ?? undefined,
        tool_results: m.tool_results ?? undefined,
      })),
      new_user_message: { content: contentParts },
    };

    for (const a of pendingAttachments) URL.revokeObjectURL(a.localUrl);
    text = '';
    pendingAttachments = [];
    expanded = false;
    onSend(payload);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    }
  }

  const canSend = $derived(
    !streaming && (!!text.trim() || pendingAttachments.some(a => a.status === 'ready'))
  );
</script>

<div class="composer" class:expanded>
  {#if pendingAttachments.length > 0}
    <div class="attachments">
      {#each pendingAttachments as att, i}
        <div class="attachment-chip" class:error={att.status === 'error'}>
          {#if att.status === 'uploading'}
            <span class="chip-spinner"></span>
          {:else if att.status === 'error'}
            <span class="chip-icon">⚠</span>
          {:else}
            <img class="chip-thumb" src={att.localUrl} alt={att.filename} />
          {/if}
          <span class="chip-name" title={att.status === 'error' ? att.errorMsg : att.filename}>
            {att.filename}
          </span>
          <button class="chip-remove" onclick={() => removeAttachment(i)} title="Remove">✕</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="composer-row">
    <textarea
      class="composer-textarea"
      bind:value={text}
      placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
      rows={3}
      onkeydown={handleKeydown}
      disabled={streaming}
    ></textarea>
    <div class="composer-controls">
      <button
        class="icon-btn"
        onclick={() => fileInputEl.click()}
        title="Attach image"
        disabled={streaming}
      >📎</button>
      <button
        class="expand-btn"
        onclick={() => expanded = !expanded}
        title={expanded ? 'Collapse' : 'Expand'}
      >{expanded ? '⤡' : '⤢'}</button>
      {#if streaming}
        <button class="send-btn stop-btn" onclick={onStop} title="Stop generation">⏹ Stop</button>
      {:else}
        <button class="send-btn" onclick={send} disabled={!canSend} title="Send">
          ↑ Send
        </button>
      {/if}
    </div>
  </div>
  <input
    bind:this={fileInputEl}
    type="file"
    accept="image/jpeg,image/png,image/gif,image/webp"
    multiple
    style="display:none"
    onchange={onFileSelected}
  />
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

  .composer.expanded {
    flex: 1;
    min-height: 0;
  }

  .composer-row {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: 8px;
  }

  .expanded .composer-row {
    flex-direction: column;
    flex: 1;
    min-height: 0;
    align-items: stretch;
  }

  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .attachment-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 6px 3px 4px;
    font-size: 12px;
    color: var(--text-secondary);
    max-width: 200px;
  }

  .attachment-chip.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .chip-thumb {
    width: 28px;
    height: 28px;
    object-fit: cover;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .chip-icon {
    font-size: 14px;
    flex-shrink: 0;
  }

  .chip-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .chip-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 11px;
    padding: 0 1px;
    line-height: 1;
    flex-shrink: 0;
  }
  .chip-remove:hover { color: var(--danger); }

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
    min-height: 72px;
    max-height: 240px;
    overflow-y: auto;
  }
  .composer-textarea:focus { border-color: var(--accent); }
  .composer-textarea:disabled { opacity: 0.6; }

  .expanded .composer-textarea {
    flex: 1;
    max-height: none;
    min-height: 0;
  }

  .composer-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .expanded .composer-controls {
    justify-content: flex-end;
  }

  .icon-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: var(--radius-sm);
    font-size: 15px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.1s, border-color 0.1s;
  }
  .icon-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--text-secondary); }
  .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .expand-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: var(--radius-sm);
    color: #c0c0c0;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color 0.1s, border-color 0.1s, background 0.1s;
  }
  .expand-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); background: var(--bg-hover); }

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
