<script lang="ts">
  import { modelsStore } from '../../stores/models.svelte';

  interface Props {
    value?: string;
    required?: boolean;
    onchange?: (value: string) => void;
  }
  let { value = $bindable(''), required = false, onchange }: Props = $props();

  let query = $state('');
  let open = $state(false);

  const selected = $derived(modelsStore.models.find(m => m.id === value));

  const options = $derived(
    query.trim()
      ? modelsStore.models.filter(m =>
          m.display_name.toLowerCase().includes(query.toLowerCase()) ||
          m.id.toLowerCase().includes(query.toLowerCase())
        )
      : modelsStore.models
  );

  function pick(id: string) {
    value = id;
    onchange?.(id);
    query = '';
    open = false;
  }

  function handleBlur() {
    // Delay so onmousedown on an option fires before the dropdown closes
    setTimeout(() => { open = false; query = ''; }, 150);
  }
</script>

<div class="picker">
  <input
    class="picker-input"
    required={required}
    value={open ? query : (selected?.display_name ?? '')}
    placeholder={modelsStore.models.length ? 'Select model…' : 'No models'}
    onfocus={() => { open = true; query = ''; }}
    onblur={handleBlur}
    oninput={(e) => { query = (e.target as HTMLInputElement).value; }}
  />
  {#if open}
    <div class="picker-dropdown">
      {#each options as m (m.id)}
        <button
          class="picker-option"
          class:active={m.id === value}
          onmousedown={() => pick(m.id)}
        >
          <span class="opt-name">{m.display_name}</span>
          <span class="opt-id">{m.id}</span>
        </button>
      {:else}
        <div class="picker-empty">No matches</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker { position: relative; min-width: 160px; }

  .picker-input {
    width: 100%;
    padding: 5px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    cursor: text;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }
  .picker-input:focus { border-color: var(--accent); }

  .picker-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 100%;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }

  .picker-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 7px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    gap: 1px;
  }
  .picker-option:hover { background: var(--bg-hover); }
  .picker-option.active { background: var(--accent-subtle); color: var(--accent); }

  .opt-id {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .picker-option.active .opt-id { color: var(--accent); opacity: 0.7; }

  .picker-empty { padding: 8px 12px; color: var(--text-muted); font-size: 13px; }
</style>
