<script lang="ts">
  import Button from '../ui/Button.svelte';
  import ResourceEditorShell from '../ui/ResourceEditorShell.svelte';
  import Select from '../ui/Select.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import type { ModelPreset } from '$lib/types';

  interface Props {
    preset?: ModelPreset | null;
    onclose: () => void;
    onsave: (data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) => Promise<void>;
  }
  let { preset = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let base_model_id = $state('');
  let system_prompt = $state('');
  let saving = $state(false);

  let initializedKey = $state<string | null>(null);

  $effect(() => {
    const key = preset?.id ?? 'new';
    if (initializedKey !== key) {
      name = preset?.name ?? '';
      base_model_id = preset?.base_model_id ?? (modelsStore.models[0]?.id ?? '');
      system_prompt = preset?.system_prompt ?? '';
      initializedKey = key;
    } else if (!base_model_id && modelsStore.models[0]?.id) {
      base_model_id = modelsStore.models[0].id;
    }
  });

  function close() {
    if ((name.trim() || system_prompt.trim()) && !window.confirm('Discard unsaved preset changes?')) return;
    if (!preset) {
      name = '';
      base_model_id = modelsStore.models[0]?.id ?? '';
      system_prompt = '';
    }
    onclose();
  }

  const modelOptions = $derived(modelsStore.models.map(m => ({ value: m.id, label: m.display_name })));

  async function save() {
    saving = true;
    try {
      await onsave({ name: name.trim(), base_model_id, system_prompt });
      name = '';
      base_model_id = modelsStore.models[0]?.id ?? '';
      system_prompt = '';
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<ResourceEditorShell
  headingId="preset-editor-title"
  title={preset ? 'Edit preset' : 'Create a new preset'}
  description={preset ? 'Update this personal preset.' : 'Personal presets are visible only to your account.'}
  onsubmit={(e) => { e.preventDefault(); save(); }}
>
  {#snippet children()}
      <div class="field">
        <label class="label" for="pr-name">Preset name</label>
        <input class="input" id="pr-name" bind:value={name} placeholder="My preset…" required maxlength="200" />
      </div>
      <div class="field">
        <label class="label" for="pr-model">Model</label>
        <Select id="pr-model" bind:value={base_model_id} options={modelOptions} required />
      </div>
      <div class="field">
        <label class="label" for="pr-sysprompt">System prompt</label>
        <textarea class="textarea" id="pr-sysprompt" bind:value={system_prompt} rows={7} maxlength="100000" placeholder="Optional system prompt…"></textarea>
      </div>
  {/snippet}
  {#snippet actions()}
        {#if preset}<Button variant="ghost" onclick={close}>Cancel editing</Button>
        {:else if name.trim() || system_prompt.trim()}<Button variant="ghost" onclick={close}>Clear</Button>{/if}
        <Button variant="primary" type="submit" loading={saving}>{preset ? 'Save changes' : 'Save preset'}</Button>
  {/snippet}
</ResourceEditorShell>

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
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
    resize: vertical;
    outline: none;
    font-family: var(--font-mono);
    line-height: 1.5;
  }
  .textarea:focus { border-color: var(--accent); }
</style>
