<script lang="ts">
  import type { AutomationRun } from '$lib/types';
  import { formatDate } from '$lib/utils';
  import Badge from '../ui/Badge.svelte';

  interface Props { runs: AutomationRun[]; }
  let { runs }: Props = $props();

  function statusVariant(status: AutomationRun['status']): 'success' | 'danger' | 'warning' {
    if (status === 'done') return 'success';
    if (status === 'error') return 'danger';
    return 'warning';
  }
</script>

{#if runs.length === 0}
  <p class="empty">No runs yet.</p>
{:else}
  <table class="run-table">
    <thead>
      <tr>
        <th>Started</th>
        <th>Status</th>
        <th>Conversation</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr>
          <td class="mono">{formatDate(run.started_at)}</td>
          <td><Badge variant={statusVariant(run.status)}>{run.status}</Badge></td>
          <td>
            {#if run.conversation_id}
              <a href={`#/chat/${run.conversation_id}`} class="conv-link">View</a>
            {/if}
          </td>
          <td class="error-cell">{run.error ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .empty { font-size: 12px; color: var(--text-muted); }
  .run-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border-subtle); }
  th { font-size: 11px; color: var(--text-muted); font-weight: 600; letter-spacing: 0.04em; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .conv-link { color: var(--accent); }
  .error-cell { color: var(--danger); font-size: 12px; font-family: var(--font-mono); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
