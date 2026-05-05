<script lang="ts">
  import { promptsStore } from '../../stores/prompts.svelte';
  import Select from '../ui/Select.svelte';

  interface Props {
    value?: string;
    onchange?: (promptId: string) => void;
    presetLabel?: string;
  }
  let { value = $bindable(''), onchange, presetLabel }: Props = $props();

  const options = $derived([
    ...(presetLabel ? [{ value: '__preset__', label: `↳ ${presetLabel}` }] : []),
    { value: '', label: 'No system prompt' },
    ...promptsStore.system.map(p => ({ value: p.id, label: `[System] ${p.name}` })),
    ...promptsStore.personal.map(p => ({ value: p.id, label: p.name })),
  ]);
</script>

<Select bind:value {options} onchange={onchange} />
