<script lang="ts">
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

{#if open}
  <aside class="editor-panel">
    <div class="editor-header">
      <div>
        <h3>{prompt ? 'Edit prompt' : 'New prompt'}</h3>
        <p>Only you can see and edit personal prompts.</p>
      </div>
      <button class="close-button" type="button" onclick={onclose} aria-label="Close editor">✕</button>
    </div>
    <div class="editor-body">
      <div class="field">
        <label class="label" for="pe-name">Name</label>
        <input class="input" id="pe-name" bind:value={name} placeholder="Prompt name…" />
      </div>
      <div class="field">
        <label class="label" for="pe-content">Content</label>
        <textarea class="textarea" id="pe-content" bind:value={content} rows={12} placeholder="System prompt content…"></textarea>
      </div>
    </div>
    <div class="actions">
      <Button variant="ghost" onclick={onclose}>Cancel</Button>
      <Button variant="primary" loading={saving} onclick={save}>Save prompt</Button>
    </div>
  </aside>
{/if}

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
  .editor-panel { position: sticky; top: 0; min-width: 0; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
  .editor-header { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border); }
  .editor-header h3 { font-size: 15px; }
  .editor-header p { margin-top: 4px; color: var(--text-muted); font-size: 12px; line-height: 1.4; }
  .close-button { align-self: flex-start; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; padding: 2px 4px; }
  .close-button:hover { color: var(--text-primary); }
  .editor-body { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
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
  .actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 16px 16px; }
</style>
