<script lang="ts">
  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon' | 'dashed';
    size?: 'sm' | 'md';
    loading?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    title?: string;
    onclick?: (e: MouseEvent) => void;
    children: import('svelte').Snippet;
  }
  let { variant = 'ghost', size = 'md', loading = false, disabled = false, type = 'button', title, onclick, children }: Props = $props();
</script>

<button
  {type}
  {title}
  disabled={disabled || loading}
  class="btn btn-{variant} size-{size}"
  onclick={onclick}
>
  {#if loading}
    <span class="btn-spinner"></span>
  {/if}
  {@render children()}
</button>

<style>
  .size-sm {
    padding: var(--spacing-xs) var(--spacing-md);
    font-size: var(--font-size-xs);
  }

  .btn-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
