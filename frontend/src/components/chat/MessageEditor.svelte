<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../ui/Button.svelte';
  import type { Message } from '$lib/types';

  interface Props {
    message: Message;
    value: string;
    disabled: boolean;
    onchange: (value: string) => void;
    oncancel: () => void;
    onsave: (message: Message, value: string) => Promise<void>;
  }
  let { message, value, disabled, onchange, oncancel, onsave }: Props = $props();
  let textarea: HTMLTextAreaElement;
  let saving = $state(false);

  onMount(() => textarea.focus({ preventScroll: true }));

  async function save() {
    if (saving || disabled || !value.trim()) return;
    saving = true;
    try {
      await onsave(message, value);
    } finally {
      saving = false;
    }
  }
</script>

<form class="message-editor" onsubmit={(event) => { event.preventDefault(); void save(); }}>
  <textarea
    class="edit-area"
    bind:this={textarea}
    {value}
    oninput={(event) => onchange(event.currentTarget.value)}
    disabled={saving}
    rows={6}
    maxlength="1000000"
    aria-label={message.role === 'user' ? 'Edit message' : 'Edit response'}
  ></textarea>
  {#if message.role === 'user'}
    <p class="edit-hint">Saving regenerates the response and replaces all following messages.</p>
  {/if}
  <div class="edit-actions">
    <Button variant="ghost" size="sm" disabled={saving} onclick={oncancel}>Cancel editing</Button>
    <Button variant="primary" size="sm" type="submit" loading={saving} disabled={disabled || !value.trim()}>
      {message.role === 'user' ? 'Save & Regenerate' : 'Save changes'}
    </Button>
  </div>
</form>

<style>
  .message-editor { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
  .edit-area {
    width: 100%;
    resize: vertical;
    min-height: 100px;
    padding: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-input-sans);
    /* Even line boxes keep WebKit's native caret aligned at fractional row positions. */
    line-height: 22px;
    outline: none;
  }
  .edit-area:focus { border-color: var(--accent); }
  .edit-hint { font-size: 12px; color: var(--text-muted); }
  .edit-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
</style>
