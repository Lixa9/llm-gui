<script lang="ts">
  import { promptsStore } from '../../stores/prompts.svelte';
  import PromptEditor from './PromptEditor.svelte';
  import ResourcePage from '../ui/ResourcePage.svelte';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import type { SystemPrompt } from '$lib/types';
  import { withToast } from '../ui/Toast.svelte';

  let editingPrompt = $state<SystemPrompt | null>(null);
  let deletingPrompt = $state<SystemPrompt | null>(null);

  async function save(name: string, content: string) {
    await withToast(
      () => editingPrompt
        ? promptsStore.update(editingPrompt.id, { name, content })
        : promptsStore.create({ name, content }),
      editingPrompt ? 'Prompt updated' : 'Prompt created',
    );
  }

  async function confirmDelete() {
    const id = deletingPrompt?.id;
    if (!id) return;
    try { await withToast(() => promptsStore.remove(id), 'Prompt deleted'); }
    finally { deletingPrompt = null; }
  }
</script>

<ResourcePage title="Prompt Library" subtitle="Create personal prompts stored securely for your account.">
  {#snippet children()}

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
                {#if deletingPrompt?.id === prompt.id}
                  <span class="delete-question">Delete this prompt?</span>
                  <Button variant="ghost" size="sm" onclick={() => deletingPrompt = null}>Cancel</Button>
                  <Button variant="danger" size="sm" onclick={confirmDelete}>Delete</Button>
                {:else}
                  <Button variant="ghost" size="sm" onclick={() => editingPrompt = prompt}>Edit</Button>
                  <Button variant="danger" size="sm" onclick={() => deletingPrompt = prompt}>Delete</Button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
    {/if}
  {/snippet}
  {#snippet editor()}
    <PromptEditor
      prompt={editingPrompt}
      onclose={() => editingPrompt = null}
      onsave={save}
    />
  {/snippet}
</ResourcePage>

<style>
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
  .prompt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .delete-question { color: var(--danger); font-size: 12px; margin-right: auto; }

</style>
