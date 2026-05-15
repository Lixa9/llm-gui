<script lang="ts">
  import { automationsStore } from '../../stores/automations.svelte';
  import AutomationEditor from './AutomationEditor.svelte';
  import RunHistoryTable from './RunHistoryTable.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import type { Automation } from '$lib/types';
  import { toast, withToast } from '../ui/Toast.svelte';
  import { onMount } from 'svelte';

  onMount(() => automationsStore.load());

  let editorOpen = $state(false);
  let editing = $state<Automation | null>(null);
  let deleting = $state<Automation | null>(null);
  let expandedRuns = $state<Set<string>>(new Set());

  const systemAutomations = $derived(automationsStore.automations.filter(a => a.owner_sub === null));
  const personalAutomations = $derived(automationsStore.automations.filter(a => a.owner_sub !== null));

  async function save(data: Pick<Automation, 'name' | 'type' | 'definition'>) {
    try {
      if (editing) {
        await automationsStore.update(editing.id, data);
        toast('Automation updated', 'success');
      } else {
        await automationsStore.create(data);
        toast('Automation created', 'success');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
      throw e;
    }
  }

  async function trigger(id: string) {
    try {
      await automationsStore.trigger(id);
      toast('Automation triggered', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function toggleRuns(id: string) {
    const next = new Set(expandedRuns);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      await automationsStore.loadRuns(id);
    }
    expandedRuns = next;
  }

  async function toggleEnabled(a: Automation) {
    await withToast(() => automationsStore.update(a.id, { enabled: !a.enabled }));
  }
</script>

<div class="view">
  <div class="view-header">
    <h2 class="view-title">Automations</h2>
    <Button variant="primary" onclick={() => { editing = null; editorOpen = true; }}>+ New automation</Button>
  </div>

  {#if systemAutomations.length > 0}
    <section class="section">
      <h3 class="section-title">System automations <Badge variant="muted">read-only</Badge></h3>
      <div class="auto-list">
        {#each systemAutomations as auto (auto.id)}
          <div class="auto-card">
            <div class="auto-header">
              <div class="auto-info">
                <span class="auto-name">{auto.name}</span>
                <Badge variant={auto.type === 'scheduled' ? 'accent' : 'default'}>{auto.type}</Badge>
                <Badge variant={auto.enabled ? 'success' : 'muted'}>{auto.enabled ? 'enabled' : 'disabled'}</Badge>
              </div>
              <div class="auto-actions">
                <Button variant="ghost" size="sm" onclick={() => trigger(auto.id)}>▶ Run</Button>
              </div>
            </div>
            <button class="runs-toggle" onclick={() => toggleRuns(auto.id)}>
              {expandedRuns.has(auto.id) ? '▾' : '▸'} Run history
            </button>
            {#if expandedRuns.has(auto.id)}
              <RunHistoryTable runs={automationsStore.runsByAutomation[auto.id] ?? []} />
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class="section">
    <h3 class="section-title">My automations</h3>
    {#if personalAutomations.length === 0}
      <p class="empty-hint">No automations yet.</p>
    {:else}
      <div class="auto-list">
        {#each personalAutomations as auto (auto.id)}
          <div class="auto-card">
            <div class="auto-header">
              <div class="auto-info">
                <span class="auto-name">{auto.name}</span>
                <Badge variant={auto.type === 'scheduled' ? 'accent' : 'default'}>{auto.type}</Badge>
                <Badge variant={auto.enabled ? 'success' : 'muted'}>{auto.enabled ? 'enabled' : 'disabled'}</Badge>
              </div>
              <div class="auto-actions">
                <Button variant="ghost" size="sm" onclick={() => toggleEnabled(auto)}>
                  {auto.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="ghost" size="sm" onclick={() => trigger(auto.id)}>▶ Run</Button>
                <Button variant="ghost" size="sm" onclick={() => { editing = auto; editorOpen = true; }}>Edit</Button>
                <Button variant="danger" size="sm" onclick={() => deleting = auto}>Delete</Button>
              </div>
            </div>
            <button class="runs-toggle" onclick={() => toggleRuns(auto.id)}>
              {expandedRuns.has(auto.id) ? '▾' : '▸'} Run history
            </button>
            {#if expandedRuns.has(auto.id)}
              <RunHistoryTable runs={automationsStore.runsByAutomation[auto.id] ?? []} />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<AutomationEditor
  open={editorOpen}
  automation={editing}
  onclose={() => editorOpen = false}
  onsave={save}
/>

<ConfirmDialog
  open={deleting !== null}
  title="Delete automation"
  message={`Delete "${deleting?.name}"?`}
  confirmLabel="Delete"
  onconfirm={async () => {
    const id = deleting?.id;
    if (id) await withToast(() => automationsStore.remove(id), 'Automation deleted');
    deleting = null;
  }}
  oncancel={() => deleting = null}
/>

<style>
  .view { padding: 24px; max-width: 900px; display: flex; flex-direction: column; gap: 20px; }
  .view-header { display: flex; align-items: center; justify-content: space-between; }
  .view-title { font-size: 20px; font-weight: 600; }
  .empty-hint { font-size: 13px; color: var(--text-muted); }
  .section { display: flex; flex-direction: column; gap: 10px; }
  .section-title { font-size: 13px; color: var(--text-secondary); font-weight: 600; display: flex; align-items: center; gap: 8px; }

  .auto-list { display: flex; flex-direction: column; gap: 10px; }
  .auto-card {
    padding: 14px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .auto-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .auto-info { display: flex; align-items: center; gap: 8px; }
  .auto-name { font-weight: 600; font-size: 14px; }
  .auto-actions { display: flex; gap: 6px; }

  .runs-toggle {
    font-size: 12px;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }
  .runs-toggle:hover { color: var(--text-secondary); }
</style>
