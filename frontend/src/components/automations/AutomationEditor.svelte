<script lang="ts">
  import Button from '../ui/Button.svelte';
  import ResourceEditorShell from '../ui/ResourceEditorShell.svelte';
  import Select from '../ui/Select.svelte';
  import ModelPicker from '../chat/ModelPicker.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import type { Automation, ScheduleUnit, ScheduledDefinition } from '$lib/types';

  interface Props {
    automation?: Automation | null;
    onclose: () => void;
    onsave: (data: Pick<Automation, 'name' | 'definition'>) => Promise<void>;
  }
  let { automation = null, onclose, onsave }: Props = $props();

  let name = $state('');
  let interval = $state(1);
  let unit = $state<ScheduleUnit>('days');
  let model = $state('');
  let systemPrompt = $state('');
  let userPrompt = $state('');
  let saving = $state(false);

  const unitOptions = [
    { value: 'hours', label: 'hours' },
    { value: 'days', label: 'days' },
    { value: 'weeks', label: 'weeks' },
  ];

  let initializedKey = $state<string | null>(null);

  $effect(() => {
    const key = automation?.id ?? 'new';
    if (initializedKey !== key) {
      name = automation?.name ?? '';
      const def = automation?.definition as ScheduledDefinition | undefined;
      if (def) {
        interval = def.interval ?? 1;
        unit = def.unit ?? 'days';
        model = def.model ?? (modelsStore.models[0]?.id ?? '');
        systemPrompt = def.system_prompt ?? '';
        userPrompt = def.user_prompt ?? '';
      } else {
        model = modelsStore.models[0]?.id ?? '';
      }
      initializedKey = key;
    } else if (!model && modelsStore.models[0]?.id) {
      model = modelsStore.models[0].id;
    }
  });

  function close() {
    if ((name.trim() || systemPrompt.trim() || userPrompt.trim()) && !window.confirm('Discard unsaved automation changes?')) return;
    if (!automation) {
      name = '';
      interval = 1;
      unit = 'days';
      model = modelsStore.models[0]?.id ?? '';
      systemPrompt = '';
      userPrompt = '';
    }
    onclose();
  }

  function clampInterval() {
    const v = Math.floor(interval);
    interval = isNaN(v) || v < 1 ? 1 : v;
  }

  async function save() {
    saving = true;
    try {
      const definition = { interval, unit, model, system_prompt: systemPrompt, user_prompt: userPrompt };
      await onsave({ name: name.trim(), definition });
      name = '';
      interval = 1;
      unit = 'days';
      model = modelsStore.models[0]?.id ?? '';
      systemPrompt = '';
      userPrompt = '';
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

<ResourceEditorShell
  headingId="automation-editor-title"
  title={automation ? 'Edit automation' : 'Create a new automation'}
  description={automation ? 'Update this personal automation.' : 'Personal automations are visible only to your account.'}
  onsubmit={(e) => { e.preventDefault(); save(); }}
>
  {#snippet children()}
      <div class="field">
        <label class="label" for="ae-name">Name</label>
        <input class="input" id="ae-name" bind:value={name} placeholder="Automation name…" required maxlength="200" />
      </div>
      <div class="field">
        <label class="label" for="ae-interval">Run every</label>
        <div class="interval-row">
          <input
            id="ae-interval"
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
        <ModelPicker bind:value={model} required />
      </div>
      <div class="field">
        <label class="label" for="ae-sysprompt">System prompt</label>
        <textarea class="textarea" id="ae-sysprompt" bind:value={systemPrompt} rows={3} placeholder="Optional…"></textarea>
      </div>
      <div class="field">
        <label class="label" for="ae-userprompt">User prompt</label>
        <textarea class="textarea" id="ae-userprompt" bind:value={userPrompt} rows={5} placeholder="The prompt to send…" required maxlength="100000"></textarea>
      </div>
  {/snippet}
  {#snippet actions()}
        {#if automation}<Button variant="ghost" onclick={close}>Cancel editing</Button>
        {:else if name.trim() || systemPrompt.trim() || userPrompt.trim()}<Button variant="ghost" onclick={close}>Clear</Button>{/if}
        <Button variant="primary" type="submit" loading={saving}>{automation ? 'Save changes' : 'Save automation'}</Button>
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
</style>
