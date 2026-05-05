<script lang="ts">
  import { onMount, untrack } from 'svelte';

  export interface MenuItem {
    label: string;
    icon?: string;
    action: () => void;
    danger?: boolean;
    disabled?: boolean;
  }

  interface Props {
    items: MenuItem[];
    x: number;
    y: number;
    onclose: () => void;
  }
  let { items, x, y, onclose }: Props = $props();

  let menu: HTMLElement | undefined = $state();

  // Intentional one-time capture: position is fixed at open time
  let left = $state(untrack(() => x));
  let top = $state(untrack(() => y));

  onMount(() => {
    if (menu) {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) left = untrack(() => x) - rect.width;
      if (rect.bottom > window.innerHeight) top = untrack(() => y) - rect.height;
    }
    const close = () => onclose();
    document.addEventListener('click', close, { once: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') onclose(); }, { once: true });
  });
</script>

<menu
  bind:this={menu}
  class="ctx-menu"
  style="left:{left}px;top:{top}px"
  role="menu"
>
  {#each items as item}
    <button
      class="ctx-item"
      class:ctx-danger={item.danger}
      disabled={item.disabled}
      role="menuitem"
      onclick={() => { item.action(); onclose(); }}
    >
      {#if item.icon}<span class="ctx-icon">{item.icon}</span>{/if}
      {item.label}
    </button>
  {/each}
</menu>

<style>
  .ctx-menu {
    position: fixed;
    z-index: 9000;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 4px;
    min-width: 160px;
    list-style: none;
    margin: 0;
    animation: fadeIn 0.1s ease;
  }
  @keyframes fadeIn { from { opacity: 0; transform: scale(0.96); } }

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    font-size: 13px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }
  .ctx-item:hover:not(:disabled) { background: var(--bg-hover); }
  .ctx-item:disabled { opacity: 0.4; cursor: not-allowed; }
  .ctx-danger { color: var(--danger); }
  .ctx-icon { font-size: 14px; width: 16px; text-align: center; }
</style>
