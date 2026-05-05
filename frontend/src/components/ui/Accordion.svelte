<script lang="ts">
  interface Props {
    open?: boolean;
    header: import('svelte').Snippet;
    children: import('svelte').Snippet;
  }
  let { open = $bindable(false), header, children }: Props = $props();
</script>

<div class="accordion">
  <button
    class="accordion-header"
    onclick={() => open = !open}
    aria-expanded={open}
  >
    <span class="accordion-arrow" class:open>{open ? '▾' : '▸'}</span>
    {@render header()}
  </button>
  {#if open}
    <div class="accordion-body">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .accordion { width: 100%; }
  .accordion-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12px;
    font-family: var(--font-mono);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }
  .accordion-header:hover { background: var(--bg-hover); color: var(--text-primary); }
  .accordion-arrow { flex-shrink: 0; font-size: 10px; width: 10px; }
  .accordion-body {
    padding: 8px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  }
</style>
