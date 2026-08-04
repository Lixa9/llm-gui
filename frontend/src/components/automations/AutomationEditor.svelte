<script lang="ts">
  import Button from '../ui/Button.svelte';
  import Select from '../ui/Select.svelte';
  import ModelPicker from '../chat/ModelPicker.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import type { Automation, ScheduleUnit, ScheduledDefinition } from '$lib/types';

  interface Props {
    open: boolean;
    automation?: Automation | null;
    onclose: () => void;
    onsave: (data: Pick<Automation, 'name' | 'definition'>) => Promise<void>;
  }
  let { open, automation = null, onclose, onsave }: Props = $props();

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

  $effect(() => {
    if (open) {
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
    }
  });

  function clampInterval() {
    const v = Math.floor(interval);
    interval = isNaN(v) || v < 1 ? 1 : v;
  }

  async function save() {
    if (!name.trim()) return;
    saving = true;
    try {
      const definition = { interval, unit, model, system_prompt: systemPrompt, user_prompt: userPrompt, output: 'new_conversation' as const };
      await onsave({ name: name.trim(), definition });
      onclose();
    } finally {
      saving = false;
    }
  }
</script>

{#if open}
  <aside class="editor-panel">
    <div class="editor-header">
      <div>
        <h3>{automation ? 'Edit automation' : 'New automation'}</h3>
        <p>This automation is private to your account.</p>
      </div>
      <button class="close-button" type="button" onclick={onclose} aria-label="Close editor">✕</button>
    </div>
    <div class="editor-body">
      <div class="field">
        <label class="label" for="ae-name">Name</label>
        <input class="input" id="ae-name" bind:value={name} placeholder="Automation name…" />
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
        <ModelPicker bind:value={model} />
      </div>
      <div class="field">
        <label class="label" for="ae-sysprompt">System prompt</label>
        <textarea class="textarea" id="ae-sysprompt" bind:value={systemPrompt} rows={3} placeholder="Optional…"></textarea>
      </div>
      <div class="field">
        <label class="label" for="ae-userprompt">User prompt</label>
        <textarea class="textarea" id="ae-userprompt" bind:value={userPrompt} rows={5} placeholder="The prompt to send…"></textarea>
      </div>
    </div>

    <div class="actions">
      <Button variant="ghost" onclick={onclose}>Cancel</Button>
      <Button variant="primary" loading={saving} onclick={save}>Save automation</Button>
    </div>
  </aside>
{/if}

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
  .editor-panel { position: sticky; top: 0; min-width: 0; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
  .editor-header { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border); }
  .editor-header h3 { font-size: 15px; }
  .editor-header p { margin-top: 4px; color: var(--text-muted); font-size: 12px; line-height: 1.4; }
  .close-button { align-self: flex-start; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; padding: 2px 4px; }
  .close-button:hover { color: var(--text-primary); }
  .editor-body { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
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
  .actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 16px 16px; }
</style>
