<script lang="ts">
  interface Option { value: string; label: string; }
  interface Props {
    value?: string;
    options: Option[];
    disabled?: boolean;
    placeholder?: string;
    id?: string;
    onchange?: (value: string) => void;
  }
  let { value = $bindable(''), options, disabled, placeholder, id, onchange }: Props = $props();

  function handleChange(e: Event) {
    value = (e.target as HTMLSelectElement).value;
    onchange?.(value);
  }
</script>

<select
  {id}
  bind:value
  {disabled}
  class="select"
  onchange={handleChange}
>
  {#if placeholder}
    <option value="" disabled selected={!value}>{placeholder}</option>
  {/if}
  {#each options as opt (opt.value)}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>

<style>
  .select {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    cursor: pointer;
    transition: border-color 0.15s;
    appearance: auto;
  }
  .select:focus { border-color: var(--accent); }
  .select:disabled { opacity: 0.5; }
  option { background: var(--bg-elevated); }
</style>
