<script lang="ts">
  import type { Message } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';
  import { extractTextFromContent } from '$lib/utils';

  interface Props {
    message: Message;
    isStreaming?: boolean;
    onEdit: () => void;
    onRegenerate: () => void;
    onDelete: () => void;
    onFork: () => void;
  }
  let { message, isStreaming = false, onEdit, onRegenerate, onDelete, onFork }: Props = $props();

  async function copy() {
    const text = extractTextFromContent(message.content);
    await navigator.clipboard.writeText(text);
    toast('Copied!', 'success', 1500);
  }
</script>

<div class="msg-actions">
  <button class="action-btn" onclick={copy} title="Copy">⎘</button>
  <button class="action-btn" onclick={onEdit} title="Edit">✏</button>
  {#if message.role === 'assistant'}
    <button class="action-btn" onclick={onRegenerate} disabled={isStreaming} title="Regenerate">↺</button>
  {/if}
  <button class="action-btn" onclick={onFork} title="Fork from here">⎇</button>
  <button class="action-btn danger" onclick={onDelete} title="Delete">🗑</button>
</div>

<style>
  .msg-actions {
    display: flex;
    gap: 2px;
    opacity: 0.3;
    transition: opacity 0.15s;
    margin-top: 4px;
  }
  :global(.msg-wrapper:hover) .msg-actions { opacity: 1; }

  .action-btn {
    padding: 3px 7px;
    font-size: 14px;
    color: var(--text-secondary);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .action-btn:hover:not(:disabled) { background: var(--bg-surface); color: var(--text-primary); border-color: var(--border-subtle); }
  .action-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .action-btn.danger:hover { color: var(--danger); }
</style>
