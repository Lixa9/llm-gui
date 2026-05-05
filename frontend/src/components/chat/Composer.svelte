<script lang="ts">
  import { chatStore } from '../../stores/chat.svelte';
  import type { ChatPayload } from '$lib/types';

  interface Props {
    conversationId: string | null;
    selectedModel: string;
    systemPromptText: string;
    systemPromptId: string | undefined;
    onSend: (payload: ChatPayload) => void;
    onStop: () => void;
    streaming: boolean;
  }
  let { conversationId, selectedModel, systemPromptText, systemPromptId, onSend, onStop, streaming }: Props = $props();

  let text = $state('');

  function send() {
    const trimmed = text.trim();
    if (!trimmed || !selectedModel) return;

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
      new_user_message: { content: [{ type: 'text', text: trimmed }] },
    };

    text = '';
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
    <button class="send-btn" onclick={send} disabled={!text.trim()} title="Send">
      ↑ Send
    </button>
  {/if}
</div>

<style>
  .composer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 10px 16px 14px;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
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
