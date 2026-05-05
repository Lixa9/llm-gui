<script lang="ts">
  import Modal from '../ui/Modal.svelte';
  import Button from '../ui/Button.svelte';
  import type { SystemPrompt } from '$lib/types';

  interface Props {
    open: boolean;
    prompt?: SystemPrompt | null;
    onclose: () => void;
    onsave: (name: string, content: string) => Promise<void>;
  }
  let { open, prompt = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let content = $state('');
  let saving = $state(false);

  $effect(() => {
    if (open) {
      name = prompt?.name ?? '';
      content = prompt?.content ?? '';
    }
  });

  async function save() {
    if (!name.trim() || !content.trim()) return;
    saving = true;
    try {
      await onsave(name.trim(), content.trim());
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<Modal {open} {onclose} title={prompt ? 'Edit prompt' : 'New prompt'} width="540px">
  <div class="field">
    <label class="label" for="pe-name">Name</label>
    <input class="input" id="pe-name" bind:value={name} placeholder="Prompt name…" />
  </div>
  <div class="field">
    <label class="label" for="pe-content">Content</label>
    <textarea class="textarea" id="pe-content" bind:value={content} rows={8} placeholder="System prompt content…"></textarea>
  </div>
  <div class="actions">
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={saving} onclick={save}>Save</Button>
  </div>
</Modal>

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
  .label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
  .input {
    padding: 7px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .input:focus { border-color: var(--accent); }
  .textarea {
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono);
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }
  .textarea:focus { border-color: var(--accent); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
