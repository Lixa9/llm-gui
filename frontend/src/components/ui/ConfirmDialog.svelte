<script lang="ts">
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';

  interface Props {
    open: boolean;
    title?: string;
    message: string;
    confirmLabel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  }
  let { open, title = 'Confirm', message, confirmLabel = 'Confirm', onconfirm, oncancel }: Props = $props();
</script>

<Modal {open} onclose={oncancel} {title} width="360px">
  <p class="msg">{message}</p>
  <div class="actions">
    <Button variant="ghost" onclick={oncancel}>Cancel</Button>
    <Button variant="danger" onclick={onconfirm}>{confirmLabel}</Button>
  </div>
</Modal>

<style>
  .msg { color: var(--text-secondary); font-size: 14px; line-height: 1.5; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
</style>
