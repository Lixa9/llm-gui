<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    width?: string;
    children: import('svelte').Snippet;
  }
  let { open, onclose, title, width = '480px', children }: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === dialog) onclose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="modal"
  style="max-width:{width}"
  onkeydown={handleKeydown}
  onclick={handleBackdrop}
>
  {#if open}
    <div class="modal-content">
      {#if title}
        <div class="modal-header">
          <h3 class="modal-title">{title}</h3>
          <button class="modal-close" onclick={onclose} aria-label="Close">✕</button>
        </div>
      {/if}
      <div class="modal-body">
        {@render children()}
      </div>
    </div>
  {/if}
</dialog>

<style>
  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-primary);
    padding: 0;
    width: 100%;
    box-shadow: var(--shadow);
    animation: modalIn 0.15s ease;
  }
  .modal::backdrop {
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(2px);
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(-8px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  .modal-content { padding: 20px; }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .modal-title { font-size: 15px; font-weight: 600; }
  .modal-close {
    color: var(--text-muted);
    font-size: 14px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    background: transparent;
    border: none;
  }
  .modal-close:hover { color: var(--text-primary); background: var(--bg-hover); }
  .modal-body { display: flex; flex-direction: column; gap: 12px; }
</style>
