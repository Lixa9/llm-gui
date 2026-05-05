<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';
  import Select from '../ui/Select.svelte';

  interface Props {
    value?: string;
    onchange?: (presetId: string) => void;
  }
  let { value = $bindable(''), onchange }: Props = $props();

  const options = $derived([
    { value: '', label: 'No preset' },
    ...modelsStore.presets.map(p => ({ value: p.id, label: p.name })),
  ]);
</script>

<Select bind:value {options} onchange={onchange} />
