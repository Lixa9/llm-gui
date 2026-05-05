<script lang="ts">
  import { api } from '$lib/api';
  import type { Automation } from '$lib/types';
  import Badge from '../ui/Badge.svelte';
  import { onMount } from 'svelte';
  import { toast } from '../ui/Toast.svelte';

  let automations = $state<Automation[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try { automations = await api.admin.automations(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { loading = false; }
  });
</script>

<div class="admin-section">
  {#if loading}
    <p class="loading">Loading…</p>
  {:else if automations.length === 0}
    <p class="empty">No automations found.</p>
  {:else}
    <table class="table">
      <thead>
        <tr><th>Name</th><th>Type</th><th>Owner</th><th>Status</th></tr>
      </thead>
      <tbody>
        {#each automations as a (a.id)}
          <tr>
            <td class="cell-name">{a.name}</td>
            <td><Badge variant="default">{a.type}</Badge></td>
            <td class="cell-owner">{a.owner_sub ?? 'system'}</td>
            <td><Badge variant={a.enabled ? 'success' : 'muted'}>{a.enabled ? 'enabled' : 'disabled'}</Badge></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .loading, .empty { font-size: 13px; color: var(--text-muted); }
  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border-subtle); }
  th { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .cell-name { font-weight: 500; }
  .cell-owner { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
</style>
