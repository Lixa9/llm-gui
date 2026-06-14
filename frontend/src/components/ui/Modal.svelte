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
    {#if title}
      <div class="modal-header">
        <span>{title}</span>
        <button class="modal-close" onclick={onclose} aria-label="Close">✕</button>
      </div>
    {/if}
    <div class="modal-body">
      {@render children()}
    </div>
  {/if}
</dialog>

<style>
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(2px);
  }

  dialog[open] {
    animation: modalIn 0.2s ease-out;
  }

  @keyframes modalIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
