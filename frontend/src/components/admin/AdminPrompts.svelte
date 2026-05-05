<script lang="ts">
  import { api } from '$lib/api';
  import type { SystemPrompt } from '$lib/types';
  import { onMount } from 'svelte';
  import { toast } from '../ui/Toast.svelte';

  let prompts = $state<SystemPrompt[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try { prompts = await api.admin.prompts(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { loading = false; }
  });
</script>

<div class="admin-section">
  {#if loading}
    <p class="loading">Loading…</p>
  {:else if prompts.length === 0}
    <p class="empty">No prompts found.</p>
  {:else}
    <table class="table">
      <thead>
        <tr><th>Name</th><th>Owner</th><th>Content</th></tr>
      </thead>
      <tbody>
        {#each prompts as p (p.id)}
          <tr>
            <td class="cell-name">{p.name}</td>
            <td class="cell-owner">{p.owner_sub ?? 'system'}</td>
            <td class="cell-content">{p.content}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .loading, .empty { font-size: 13px; color: var(--text-muted); }
  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
  th { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .cell-name { font-weight: 500; white-space: nowrap; }
  .cell-owner { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); white-space: nowrap; }
  .cell-content { color: var(--text-secondary); max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
