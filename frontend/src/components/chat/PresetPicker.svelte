<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';
  import Select from '../ui/Select.svelte';

  interface Props {
    onselect?: (presetId: string) => void;
  }
  let { onselect }: Props = $props();

  let value = $state('');

  const options = $derived([
    { value: '', label: 'No preset' },
    ...modelsStore.presets.map(p => ({ value: p.id, label: p.name })),
  ]);

  function handleChange(v: string) {
    value = v;
    onselect?.(v);
  }
</script>

<Select bind:value {options} onchange={handleChange} />
