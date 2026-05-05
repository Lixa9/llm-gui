<script lang="ts">
  import { promptsStore } from '../../stores/prompts.svelte';
  import Select from '../ui/Select.svelte';

  interface Props {
    value?: string;
    onchange?: (promptId: string) => void;
  }
  let { value = $bindable(''), onchange }: Props = $props();

  const options = $derived([
    { value: '', label: 'No system prompt' },
    ...promptsStore.system.map(p => ({ value: p.id, label: `[System] ${p.name}` })),
    ...promptsStore.personal.map(p => ({ value: p.id, label: p.name })),
  ]);
</script>

<Select bind:value {options} onchange={onchange} />
