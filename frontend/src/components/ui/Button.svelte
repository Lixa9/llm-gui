<script lang="ts">
  interface Props {
    variant?: 'primary' | 'ghost' | 'danger' | 'icon';
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
  class="btn btn-{variant} btn-{size}"
  onclick={onclick}
>
  {#if loading}
    <span class="btn-spinner"></span>
  {/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.1s, border-color 0.1s, opacity 0.1s;
    white-space: nowrap;
    user-select: none;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn-md { padding: 5px 12px; height: 32px; }
  .btn-sm { padding: 3px 8px; height: 26px; font-size: 12px; }

  .btn-primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border);
  }
  .btn-ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }

  .btn-danger {
    background: transparent;
    color: var(--danger);
    border-color: var(--danger);
  }
  .btn-danger:hover:not(:disabled) { background: var(--danger); color: #fff; }

  .btn-icon {
    background: transparent;
    color: var(--text-muted);
    border-color: transparent;
    padding: 4px;
    border-radius: var(--radius-sm);
    height: auto;
    min-width: 0;
  }
  .btn-icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }

  .btn-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
