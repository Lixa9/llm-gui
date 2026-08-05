<script lang="ts">
  import { automationsStore } from '../../stores/automations.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import ResourcePage from '../ui/ResourcePage.svelte';
  import AutomationEditor from './AutomationEditor.svelte';
  import RunHistoryTable from './RunHistoryTable.svelte';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import type { Automation } from '$lib/types';
  import { toast, withToast } from '../ui/Toast.svelte';
  import { modelDisplayName, sortByName } from '$lib/utils';
  import { onMount } from 'svelte';

  onMount(() => automationsStore.load());

  let editing = $state<Automation | null>(null);
  let deleting = $state<Automation | null>(null);
  let expandedRuns = $state<Set<string>>(new Set());
  let expandedDetails = $state<Set<string>>(new Set());
  let triggering = $state<Set<string>>(new Set());

  const systemAutomations = $derived(sortByName(automationsStore.automations.filter(a => a.owner_sub === null)));
  const personalAutomations = $derived(sortByName(automationsStore.automations.filter(a => a.owner_sub !== null)));

  async function save(data: Pick<Automation, 'name' | 'definition'>) {
    await withToast(
      () => editing ? automationsStore.update(editing.id, data) : automationsStore.create(data),
      editing ? 'Automation updated' : 'Automation created',
    );
  }

  async function trigger(id: string) {
    const next = new Set(triggering);
    next.add(id);
    triggering = next;
    try {
      await automationsStore.trigger(id);
      toast('Automation triggered', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      const done = new Set(triggering);
      done.delete(id);
      triggering = done;
    }
  }

  async function toggleRuns(id: string) {
    const next = new Set(expandedRuns);
    if (next.has(id)) {
      next.delete(id);
    } else {
      try {
        await withToast(() => automationsStore.loadRuns(id));
        next.add(id);
      } catch {
        return;
      }
    }
    expandedRuns = next;
  }

  function toggleDetails(id: string) {
    const next = new Set(expandedDetails);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedDetails = next;
  }

  function formatDefinition(auto: Automation): string {
    const def = auto.definition as unknown as Record<string, unknown>;
    const lines: string[] = [];
    lines.push(`Schedule: every ${def.interval} ${def.unit}`);
    if (def.model) lines.push(`Model: ${modelDisplayName(modelsStore.models, String(def.model))}`);
    if (def.system_prompt) lines.push(`System prompt: ${def.system_prompt}`);
    if (def.user_prompt) lines.push(`User prompt: ${def.user_prompt}`);
    return lines.join('\n');
  }

  async function toggleEnabled(a: Automation) {
    await withToast(() => automationsStore.update(a.id, { enabled: !a.enabled }));
  }

  async function confirmDelete() {
    const id = deleting?.id;
    if (!id) return;
    await withToast(() => automationsStore.remove(id), 'Automation deleted');
    deleting = null;
  }
</script>

<ResourcePage title="Automations" subtitle="Schedule recurring prompts. Personal automations belong to your account.">
  {#snippet children()}

    {#if automationsStore.loading}
      <p class="state-hint">Loading automations…</p>
    {:else if automationsStore.error}
      <div class="error-state">
        <p>{automationsStore.error}</p>
        <Button size="sm" onclick={() => automationsStore.load()}>Retry</Button>
      </div>
    {:else if systemAutomations.length > 0}
      <section class="section">
        <h3 class="section-title">System automations <Badge variant="muted">read-only</Badge></h3>
        <div class="auto-list">
          {#each systemAutomations as auto (auto.id)}
            <div class="auto-card">
              <div class="auto-header">
                <div class="auto-info">
                  <span class="auto-name">{auto.name}</span>
                  <Badge variant={auto.enabled ? 'success' : 'muted'}>{auto.enabled ? 'subscribed' : 'not subscribed'}</Badge>
                </div>
                <div class="auto-actions">
                  <Button variant="ghost" size="sm" onclick={() => withToast(() => automationsStore.toggleSubscription(auto.id, !auto.enabled), auto.enabled ? 'Unsubscribed' : 'Subscribed')}>
                    {auto.enabled ? 'Unsubscribe' : 'Subscribe'}
                  </Button>
                </div>
              </div>
              <div class="auto-toggles">
                <button class="runs-toggle" aria-expanded={expandedDetails.has(auto.id)} onclick={() => toggleDetails(auto.id)}>
                  {expandedDetails.has(auto.id) ? '▾' : '▸'} Details
                </button>
              </div>
              {#if expandedDetails.has(auto.id)}
                <pre class="auto-details">{formatDefinition(auto)}</pre>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if !automationsStore.loading && !automationsStore.error}
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
                    <Badge variant={auto.enabled ? 'success' : 'muted'}>{auto.enabled ? 'enabled' : 'disabled'}</Badge>
                  </div>
                <div class="auto-actions">
                  {#if deleting?.id === auto.id}
                    <span class="delete-question">Delete this automation?</span>
                    <Button variant="ghost" size="sm" onclick={() => deleting = null}>Cancel</Button>
                    <Button variant="danger" size="sm" onclick={confirmDelete}>Delete</Button>
                  {:else}
                    <Button variant="ghost" size="sm" onclick={() => toggleEnabled(auto)}>
                      {auto.enabled ? 'Disable' : 'Enable'}
                    </Button>
                      <Button variant="ghost" size="sm" loading={triggering.has(auto.id)} onclick={() => trigger(auto.id)}>Run now</Button>
                      <Button variant="ghost" size="sm" onclick={() => editing = auto}>Edit</Button>
                      <Button variant="danger" size="sm" onclick={() => deleting = auto}>Delete</Button>
                  {/if}
                </div>
              </div>
                <div class="auto-toggles">
                  <button class="runs-toggle" aria-expanded={expandedDetails.has(auto.id)} onclick={() => toggleDetails(auto.id)}>
                    {expandedDetails.has(auto.id) ? '▾' : '▸'} Details
                  </button>
                  <button class="runs-toggle" aria-expanded={expandedRuns.has(auto.id)} onclick={() => toggleRuns(auto.id)}>
                    {expandedRuns.has(auto.id) ? '▾' : '▸'} Run history
                  </button>
                </div>
                {#if expandedDetails.has(auto.id)}
                  <pre class="auto-details">{formatDefinition(auto)}</pre>
                {/if}
                {#if expandedRuns.has(auto.id)}
                  <RunHistoryTable runs={automationsStore.runsByAutomation[auto.id] ?? []} />
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/snippet}
  {#snippet editor()}
    <AutomationEditor
      automation={editing}
      onclose={() => editing = null}
      onsave={save}
    />
  {/snippet}
</ResourcePage>

<style>
  .empty-hint, .state-hint { font-size: 13px; color: var(--text-muted); }
  .error-state { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--danger); font-size: 13px; }
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
  .auto-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .delete-question { color: var(--danger); font-size: 12px; margin-right: auto; }

  .auto-toggles { display: flex; gap: 16px; }
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
  .auto-details {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

</style>
