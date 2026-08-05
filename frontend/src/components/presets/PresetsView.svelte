<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';
  import { preferencesStore } from '../../stores/preferences.svelte';
  import PresetEditor from './PresetEditor.svelte';
  import ResourcePage from '../ui/ResourcePage.svelte';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import type { ModelPreset } from '$lib/types';
  import { withToast } from '../ui/Toast.svelte';
  import { modelDisplayName, sortByName } from '$lib/utils';

  let editing = $state<ModelPreset | null>(null);
  let deleting = $state<ModelPreset | null>(null);

  const systemPresets = $derived(sortByName(modelsStore.presets.filter(p => p.owner_sub === null)));
  const personalPresets = $derived(sortByName(modelsStore.presets.filter(p => p.owner_sub !== null)));

  async function save(data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) {
    await withToast(
      () => editing ? modelsStore.updatePreset(editing.id, data) : modelsStore.createPreset(data),
      editing ? 'Preset updated' : 'Preset created',
    );
  }

  async function confirmDelete() {
    const id = deleting?.id;
    if (!id) return;
    try { await withToast(() => modelsStore.deletePreset(id), 'Preset deleted'); }
    finally { deleting = null; }
  }

  function toggleDefault(preset: ModelPreset) {
    const isDefault = preferencesStore.defaultPresetId === preset.id;
    preferencesStore.set('default_preset_id', isDefault ? '' : preset.id);
  }
</script>

<ResourcePage title="Model Presets" subtitle="Bundle a model and system prompt for your own account.">
  {#snippet children()}

    {#if modelsStore.loading}
      <p class="state-hint">Loading presets…</p>
    {:else if modelsStore.error}
      <div class="error-state">
        <p>{modelsStore.error}</p>
        <Button size="sm" onclick={() => modelsStore.load()}>Retry</Button>
      </div>
    {:else if systemPresets.length > 0}
      <section class="section">
        <h3 class="section-title">System presets <Badge variant="muted">read-only</Badge></h3>
        <div class="preset-grid">
          {#each systemPresets as preset (preset.id)}
            <div class="preset-card">
              <div class="preset-name">
                {preset.name}
                {#if preferencesStore.defaultPresetId === preset.id}
                  <Badge variant="accent">Default</Badge>
                {/if}
              </div>
              <div class="preset-model">{modelDisplayName(modelsStore.models, preset.base_model_id)}</div>
              {#if preset.system_prompt}
                <div class="preset-prompt">{preset.system_prompt}</div>
                <details class="content-details">
                  <summary>View full prompt</summary>
                  <pre>{preset.system_prompt}</pre>
                </details>
              {/if}
              <div class="preset-actions">
                <Button variant="ghost" size="sm" onclick={() => toggleDefault(preset)}>
                  {preferencesStore.defaultPresetId === preset.id ? 'Unset default' : 'Set as default'}
                </Button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if !modelsStore.loading && !modelsStore.error}
    <section class="section">
      <h3 class="section-title">My presets</h3>
      {#if personalPresets.length === 0}
        <p class="empty-hint">No presets yet. Create a preset to bundle a model with a system prompt.</p>
      {:else}
        <div class="preset-grid">
          {#each personalPresets as preset (preset.id)}
            <div class="preset-card">
              <div class="preset-name">
                {preset.name}
                {#if preferencesStore.defaultPresetId === preset.id}
                  <Badge variant="accent">Default</Badge>
                {/if}
              </div>
              <div class="preset-model">{modelDisplayName(modelsStore.models, preset.base_model_id)}</div>
              {#if preset.system_prompt}
                <div class="preset-prompt">{preset.system_prompt}</div>
                <details class="content-details">
                  <summary>View full prompt</summary>
                  <pre>{preset.system_prompt}</pre>
                </details>
              {/if}
              <div class="preset-actions">
                {#if deleting?.id === preset.id}
                  <span class="delete-question">Delete this preset?</span>
                  <Button variant="ghost" size="sm" onclick={() => deleting = null}>Cancel</Button>
                  <Button variant="danger" size="sm" onclick={confirmDelete}>Delete</Button>
                {:else}
                  <Button variant="ghost" size="sm" onclick={() => toggleDefault(preset)}>
                    {preferencesStore.defaultPresetId === preset.id ? 'Unset default' : 'Set as default'}
                  </Button>
                  <Button variant="ghost" size="sm" onclick={() => editing = preset}>Edit</Button>
                  <Button variant="danger" size="sm" onclick={() => deleting = preset}>Delete</Button>
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
    <PresetEditor
      preset={editing}
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

  .preset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .preset-card {
    padding: 14px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .preset-name { font-weight: 600; font-size: 14px; }
  .preset-model { font-size: 12px; color: var(--accent); }
  .preset-prompt {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
  }
  .content-details { font-size: 12px; color: var(--text-muted); }
  .content-details summary { cursor: pointer; }
  .content-details pre { margin-top: 8px; padding: 10px 12px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-secondary); font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  .preset-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .delete-question { color: var(--danger); font-size: 12px; margin-right: auto; }

</style>
