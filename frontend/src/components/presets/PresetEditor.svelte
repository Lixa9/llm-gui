<script lang="ts">
  import Modal from '../ui/Modal.svelte';
  import Button from '../ui/Button.svelte';
  import Select from '../ui/Select.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import type { ModelPreset } from '$lib/types';

  interface Props {
    open: boolean;
    preset?: ModelPreset | null;
    onclose: () => void;
    onsave: (data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) => Promise<void>;
  }
  let { open, preset = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let base_model_id = $state('');
  let system_prompt = $state('');
  let saving = $state(false);

  $effect(() => {
    if (open) {
      name = preset?.name ?? '';
      base_model_id = preset?.base_model_id ?? (modelsStore.models[0]?.id ?? '');
      system_prompt = preset?.system_prompt ?? '';
    }
  });

  const modelOptions = $derived(modelsStore.models.map(m => ({ value: m.id, label: m.display_name })));

  async function save() {
    if (!name.trim() || !base_model_id) return;
    saving = true;
    try {
      await onsave({ name: name.trim(), base_model_id, system_prompt });
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<Modal {open} {onclose} title={preset ? 'Edit preset' : 'New preset'} width="500px">
  <div class="field">
    <label class="label" for="pr-name">Preset name</label>
    <input class="input" id="pr-name" bind:value={name} placeholder="My preset…" />
  </div>
  <div class="field">
    <label class="label" for="pr-model">Model</label>
    <Select id="pr-model" bind:value={base_model_id} options={modelOptions} />
  </div>
  <div class="field">
    <label class="label" for="pr-sysprompt">System prompt</label>
    <textarea class="textarea" id="pr-sysprompt" bind:value={system_prompt} rows={5} placeholder="Optional system prompt…"></textarea>
  </div>
  <div class="actions">
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={saving} onclick={save}>Save</Button>
  </div>
</Modal>

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
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
