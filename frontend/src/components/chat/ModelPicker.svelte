<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';
  import Select from '../ui/Select.svelte';

  interface Props {
    value?: string;
    onchange?: (modelId: string) => void;
  }
  let { value = $bindable(''), onchange }: Props = $props();

  const options = $derived(modelsStore.models.map(m => ({ value: m.id, label: m.display_name })));
</script>

<Select bind:value {options} placeholder="Select model…" onchange={onchange} />
