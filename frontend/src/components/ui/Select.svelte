<script lang="ts">
  interface Option { value: string; label: string; }
  interface Props {
    value?: string;
    options: Option[];
    disabled?: boolean;
    placeholder?: string;
    id?: string;
    required?: boolean;
    onchange?: (value: string) => void;
  }
  let { value = $bindable(''), options, disabled, placeholder, id, required = false, onchange }: Props = $props();

  function handleChange(e: Event) {
    value = (e.target as HTMLSelectElement).value;
    onchange?.(value);
  }
</script>

<select
  {id}
  bind:value
  {disabled}
  {required}
  onchange={handleChange}
>
  {#if placeholder}
    <option value="" disabled selected={!value}>{placeholder}</option>
  {/if}
  {#each options as opt (opt.value)}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>
