<script lang="ts">
  import Button from '../ui/Button.svelte';
  import type { SystemPrompt } from '$lib/types';

  interface Props {
    prompt?: SystemPrompt | null;
    onclose: () => void;
    onsave: (name: string, content: string) => Promise<void>;
  }
  let { prompt = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let content = $state('');
  let saving = $state(false);

  let initializedKey = $state<string | null>(null);

  $effect(() => {
    const key = prompt?.id ?? 'new';
    if (initializedKey !== key) {
      name = prompt?.name ?? '';
      content = prompt?.content ?? '';
      initializedKey = key;
    }
  });

  function close() {
    if ((name.trim() || content.trim()) && !window.confirm('Discard unsaved prompt changes?')) return;
    if (!prompt) {
      name = '';
      content = '';
    }
    onclose();
  }

  async function save() {
    saving = true;
    try {
      await onsave(name.trim(), content.trim());
      name = '';
      content = '';
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<section class="editor-panel" aria-labelledby="prompt-editor-title">
    <div class="editor-header">
      <div>
        <h3 id="prompt-editor-title">{prompt ? 'Edit prompt' : 'Create a new prompt'}</h3>
        <p>{prompt ? 'Update this personal prompt.' : 'Personal prompts are visible only to your account.'}</p>
      </div>
    </div>
    <form class="editor-form" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="editor-body">
      <div class="field">
        <label class="label" for="pe-name">Name</label>
        <input class="input" id="pe-name" bind:value={name} placeholder="Prompt name…" required maxlength="200" />
      </div>
      <div class="field">
        <label class="label" for="pe-content">Content</label>
        <textarea class="textarea" id="pe-content" bind:value={content} rows={10} placeholder="System prompt content…" required maxlength="100000"></textarea>
      </div>
      </div>
      <div class="actions">
        {#if prompt}<Button variant="ghost" onclick={close}>Cancel editing</Button>
        {:else if name.trim() || content.trim()}<Button variant="ghost" onclick={close}>Clear</Button>{/if}
        <Button variant="primary" type="submit" loading={saving}>{prompt ? 'Save changes' : 'Save prompt'}</Button>
      </div>
    </form>
</section>

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
  .editor-panel { min-width: 0; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
  .editor-header { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border); }
  .editor-header h3 { font-size: 15px; }
  .editor-header p { margin-top: 4px; color: var(--text-muted); font-size: 12px; line-height: 1.4; }
  .editor-body { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
  .editor-form { display: flex; flex-direction: column; }
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
