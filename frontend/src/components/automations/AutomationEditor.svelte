<script lang="ts">
  import Modal from '../ui/Modal.svelte';
  import Button from '../ui/Button.svelte';
  import Select from '../ui/Select.svelte';
  import ModelPicker from '../chat/ModelPicker.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import type { Automation, AutomationType, ScheduleUnit, ScheduledDefinition, PipelineDefinition, PipelineStep } from '$lib/types';

  interface Props {
    open: boolean;
    automation?: Automation | null;
    onclose: () => void;
    onsave: (data: Pick<Automation, 'name' | 'type' | 'definition'>) => Promise<void>;
  }
  let { open, automation = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let type = $state<AutomationType>('scheduled');
  let interval = $state(1);
  let unit = $state<ScheduleUnit>('days');
  let model = $state('');
  let systemPrompt = $state('');
  let userPrompt = $state('');
  let steps = $state<PipelineStep[]>([{ model: '', system_prompt: '', user_prompt: '' }]);
  let saving = $state(false);

  const unitOptions = [
    { value: 'hours', label: 'hours' },
    { value: 'days', label: 'days' },
    { value: 'weeks', label: 'weeks' },
  ];

  $effect(() => {
    if (open) {
      name = automation?.name ?? '';
      type = automation?.type ?? 'scheduled';
      const def = automation?.definition;
      if (def && automation?.type === 'scheduled') {
        const d = def as ScheduledDefinition;
        interval = d.interval ?? 1;
        unit = d.unit ?? 'days';
        model = d.model ?? (modelsStore.models[0]?.id ?? '');
        systemPrompt = d.system_prompt ?? '';
        userPrompt = d.user_prompt ?? '';
      } else if (def && automation?.type === 'pipeline') {
        steps = (def as PipelineDefinition).steps ?? [{ model: '', system_prompt: '', user_prompt: '' }];
      } else {
        model = modelsStore.models[0]?.id ?? '';
      }
    }
  });

  function clampInterval() {
    const v = Math.floor(interval);
    interval = isNaN(v) || v < 1 ? 1 : v;
  }

  function addStep() {
    steps = [...steps, { model: modelsStore.models[0]?.id ?? '', system_prompt: '', user_prompt: '' }];
  }

  function removeStep(i: number) {
    steps = steps.filter((_, idx) => idx !== i);
  }

  async function save() {
    if (!name.trim()) return;
    saving = true;
    try {
      const definition = type === 'scheduled'
        ? { interval, unit, model, system_prompt: systemPrompt, user_prompt: userPrompt, output: 'new_conversation' as const }
        : { steps };
      await onsave({ name: name.trim(), type, definition });
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<Modal {open} {onclose} title={automation ? 'Edit automation' : 'New automation'} width="560px">
  <div class="field">
    <label class="label" for="ae-name">Name</label>
    <input class="input" id="ae-name" bind:value={name} placeholder="Automation name…" />
  </div>
  <div class="field">
    <label class="label" for="ae-type">Type</label>
    <Select id="ae-type" bind:value={type} options={[{ value: 'scheduled', label: 'Scheduled' }, { value: 'pipeline', label: 'Pipeline' }]} />
  </div>

  {#if type === 'scheduled'}
    <div class="field">
      <label class="label">Run every</label>
      <div class="interval-row">
        <input
          class="input interval-input"
          type="number"
          min="1"
          step="1"
          bind:value={interval}
          onblur={clampInterval}
          oninput={() => { interval = Math.floor(interval); }}
        />
        <div class="interval-select">
          <Select bind:value={unit} options={unitOptions} />
        </div>
      </div>
    </div>
    <div class="field">
      <label class="label" for="ae-model">Model</label>
      <ModelPicker bind:value={model} />
    </div>
    <div class="field">
      <label class="label" for="ae-sysprompt">System prompt</label>
      <textarea class="textarea" id="ae-sysprompt" bind:value={systemPrompt} rows={2} placeholder="Optional…"></textarea>
    </div>
    <div class="field">
      <label class="label" for="ae-userprompt">User prompt</label>
      <textarea class="textarea" id="ae-userprompt" bind:value={userPrompt} rows={3} placeholder="The prompt to send…"></textarea>
    </div>
  {:else}
    <div class="pipeline-steps">
      {#each steps as step, i}
        <div class="step">
          <div class="step-header">
            <span class="step-num">Step {i + 1}</span>
            {#if steps.length > 1}
              <button class="step-remove" onclick={() => removeStep(i)}>✕</button>
            {/if}
          </div>
          <ModelPicker bind:value={step.model} />
          <textarea class="textarea" bind:value={step.system_prompt} rows={2} placeholder="System prompt…"></textarea>
          <textarea class="textarea" bind:value={step.user_prompt} rows={2} placeholder="User prompt…"></textarea>
        </div>
      {/each}
      <Button variant="ghost" size="sm" onclick={addStep}>+ Add step</Button>
    </div>
  {/if}

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
  .input:focus, .textarea:focus { border-color: var(--accent); }
  .interval-row { display: flex; gap: 8px; align-items: center; }
  .interval-input { width: 72px; text-align: center; }
  .interval-select { flex: 1; }
  .textarea {
    padding: 7px 10px;
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
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  .pipeline-steps { display: flex; flex-direction: column; gap: 10px; }
  .step {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .step-header { display: flex; align-items: center; justify-content: space-between; }
  .step-num { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .step-remove {
    font-size: 12px;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
  }
  .step-remove:hover { color: var(--danger); }
</style>
