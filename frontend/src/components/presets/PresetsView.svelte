<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';
  import PresetEditor from './PresetEditor.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Button from '../ui/Button.svelte';
  import type { ModelPreset } from '$lib/types';
  import { toast } from '../ui/Toast.svelte';

  let editorOpen = $state(false);
  let editing = $state<ModelPreset | null>(null);
  let deleting = $state<ModelPreset | null>(null);

  async function save(data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) {
    try {
      if (editing) {
        await modelsStore.updatePreset(editing.id, data);
        toast('Preset updated', 'success');
      } else {
        await modelsStore.createPreset(data);
        toast('Preset created', 'success');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
      throw e;
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await modelsStore.deletePreset(deleting.id);
      toast('Preset deleted', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      deleting = null;
    }
  }

  function modelName(id: string) {
    return modelsStore.models.find(m => m.id === id)?.display_name ?? id;
  }
</script>

<div class="view">
  <div class="view-header">
    <h2 class="view-title">Model Presets</h2>
    <Button variant="primary" onclick={() => { editing = null; editorOpen = true; }}>+ New preset</Button>
  </div>

  {#if modelsStore.presets.length === 0}
    <p class="empty-hint">No presets yet. Create a preset to bundle a model with a system prompt.</p>
  {:else}
    <div class="preset-grid">
      {#each modelsStore.presets as preset (preset.id)}
        <div class="preset-card">
          <div class="preset-name">{preset.name}</div>
          <div class="preset-model">{modelName(preset.base_model_id)}</div>
          {#if preset.system_prompt}
            <div class="preset-prompt">{preset.system_prompt}</div>
          {/if}
          <div class="preset-actions">
            <Button variant="ghost" size="sm" onclick={() => { editing = preset; editorOpen = true; }}>Edit</Button>
            <Button variant="danger" size="sm" onclick={() => deleting = preset}>Delete</Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<PresetEditor
  open={editorOpen}
  preset={editing}
  onclose={() => editorOpen = false}
  onsave={save}
/>

<ConfirmDialog
  open={deleting !== null}
  title="Delete preset"
  message={`Delete "${deleting?.name}"?`}
  confirmLabel="Delete"
  onconfirm={confirmDelete}
  oncancel={() => deleting = null}
/>

<style>
  .view { padding: 24px; max-width: 900px; display: flex; flex-direction: column; gap: 20px; }
  .view-header { display: flex; align-items: center; justify-content: space-between; }
  .view-title { font-size: 20px; font-weight: 600; }
  .empty-hint { font-size: 13px; color: var(--text-muted); }

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
  }
  .preset-actions { display: flex; gap: 6px; margin-top: 4px; }
</style>
