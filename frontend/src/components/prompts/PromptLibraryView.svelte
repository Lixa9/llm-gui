<script lang="ts">
  import { promptsStore } from '../../stores/prompts.svelte';
  import PromptEditor from './PromptEditor.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import type { SystemPrompt } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';

  let editingPrompt = $state<SystemPrompt | null>(null);
  let deletingPrompt = $state<SystemPrompt | null>(null);

  async function save(name: string, content: string) {
    try {
      if (editingPrompt) {
        await promptsStore.update(editingPrompt.id, { name, content });
        toast('Prompt updated', 'success');
      } else {
        await promptsStore.create({ name, content });
        toast('Prompt created', 'success');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
      throw e;
    }
  }

  async function confirmDelete() {
    if (!deletingPrompt) return;
    try {
      await promptsStore.remove(deletingPrompt.id);
      toast('Prompt deleted', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      deletingPrompt = null;
    }
  }
</script>

<div class="view">
  <div class="view-content">
    <div class="view-header">
      <div>
        <h2 class="view-title">Prompt Library</h2>
        <p class="view-subtitle">Create personal prompts stored securely for your account.</p>
      </div>
    </div>

    {#if promptsStore.loading}
      <p class="state-hint">Loading prompts…</p>
    {:else if promptsStore.error}
      <div class="error-state">
        <p>{promptsStore.error}</p>
        <Button size="sm" onclick={() => promptsStore.load()}>Retry</Button>
      </div>
    {:else if promptsStore.system.length > 0}
      <section class="section">
        <h3 class="section-title">System prompts <Badge variant="muted">read-only</Badge></h3>
        <div class="prompt-list">
          {#each promptsStore.system as prompt (prompt.id)}
            <div class="prompt-card">
              <div class="prompt-name">{prompt.name}</div>
              <div class="prompt-content">{prompt.content}</div>
              <details class="content-details">
                <summary>View full prompt</summary>
                <pre>{prompt.content}</pre>
              </details>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if !promptsStore.loading && !promptsStore.error}
    <section class="section">
      <h3 class="section-title">My prompts</h3>
      {#if promptsStore.personal.length === 0}
        <p class="empty-hint">No personal prompts yet. Create one to get started.</p>
      {:else}
        <div class="prompt-list">
          {#each promptsStore.personal as prompt (prompt.id)}
            <div class="prompt-card">
              <div class="prompt-name">{prompt.name}</div>
              <div class="prompt-content">{prompt.content}</div>
              <details class="content-details">
                <summary>View full prompt</summary>
                <pre>{prompt.content}</pre>
              </details>
              <div class="prompt-actions">
                <Button variant="ghost" size="sm" onclick={() => editingPrompt = prompt}>Edit</Button>
                <Button variant="danger" size="sm" onclick={() => deletingPrompt = prompt}>Delete</Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    {/if}
  </div>

  <PromptEditor
    prompt={editingPrompt}
    onclose={() => editingPrompt = null}
    onsave={save}
  />
</div>

<ConfirmDialog
  open={deletingPrompt !== null}
  title="Delete prompt"
  message={`Delete "${deletingPrompt?.name}"? This cannot be undone.`}
  confirmLabel="Delete"
  onconfirm={confirmDelete}
  oncancel={() => deletingPrompt = null}
/>

<style>
  .view { padding: 24px; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 24px; overflow: auto; }
  .view-content, :global(.editor-panel) { width: min(100%, 1000px); }
  .view-content { min-width: 0; display: flex; flex-direction: column; gap: 24px; }
  .view-header { display: flex; align-items: center; justify-content: space-between; }
  .view-title { font-size: 20px; font-weight: 600; }
  .view-subtitle { margin-top: 4px; font-size: 13px; color: var(--text-muted); }

  .section { display: flex; flex-direction: column; gap: 10px; }
  .section-title { font-size: 13px; color: var(--text-secondary); font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .empty-hint, .state-hint { font-size: 13px; color: var(--text-muted); }
  .error-state { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--danger); font-size: 13px; }

  .prompt-list { display: flex; flex-direction: column; gap: 8px; }
  .prompt-card {
    padding: 14px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .prompt-name { font-weight: 600; font-size: 14px; }
  .prompt-content {
    font-size: 13px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    white-space: pre-wrap;
    max-height: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    line-clamp: 3;
  }
  .content-details { font-size: 12px; color: var(--text-muted); }
  .content-details summary { cursor: pointer; }
  .content-details pre { margin-top: 8px; padding: 10px 12px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-secondary); font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  .prompt-actions { display: flex; gap: 6px; margin-top: 4px; }

  @media (max-width: 760px) {
    .view { padding: 16px; }
    .view-header { align-items: flex-start; gap: 12px; flex-direction: column; }
  }
</style>
