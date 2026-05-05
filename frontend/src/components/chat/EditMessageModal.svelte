<script lang="ts">
  import Modal from '../ui/Modal.svelte';
  import Button from '../ui/Button.svelte';
  import type { Message } from '$lib/types';
  import { extractTextFromContent } from '$lib/utils';

  interface Props {
    open: boolean;
    message: Message | null;
    onclose: () => void;
    onsave: (messageId: string, newContent: string, role: string) => void;
  }
  let { open, message, onclose, onsave }: Props = $props();

  let value = $state('');

  $effect(() => {
    if (message) value = extractTextFromContent(message.content);
  });

  function save() {
    if (!message || !value.trim()) return;
    onsave(message.id, value, message.role);
    onclose();
  }
</script>

<Modal {open} {onclose} title={message?.role === 'user' ? 'Edit message' : 'Edit response'} width="560px">
  <!-- svelte-ignore a11y_autofocus -->
  <textarea
    class="edit-area"
    bind:value
    rows={6}
    autofocus={open}
  ></textarea>
  {#if message?.role === 'user'}
    <p class="edit-hint">Editing a user message will regenerate the assistant's response.</p>
  {:else}
    <p class="edit-hint">Editing an assistant message saves it directly without calling the AI.</p>
  {/if}
  <div class="edit-actions">
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={save}>Save{message?.role === 'user' ? ' & Regenerate' : ''}</Button>
  </div>
</Modal>

<style>
  .edit-area {
    width: 100%;
    resize: vertical;
    padding: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-sans);
    line-height: 1.5;
    outline: none;
  }
  .edit-area:focus { border-color: var(--accent); }
  .edit-hint { font-size: 12px; color: var(--text-muted); }
  .edit-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
