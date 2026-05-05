<script lang="ts">
  import { getToasts, dismiss } from './Toast.svelte';

  const icons: Record<string, string> = {
    info: 'ℹ',
    success: '✓',
    error: '✕',
    warning: '⚠',
  };
</script>

<div class="toast-container">
  {#each getToasts() as t (t.id)}
    <div class="toast toast-{t.type}" role="alert">
      <span class="toast-icon">{icons[t.type]}</span>
      <span class="toast-msg">{t.message}</span>
      <button class="toast-dismiss" onclick={() => dismiss(t.id)}>✕</button>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: var(--radius);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    font-size: 13px;
    min-width: 240px;
    max-width: 380px;
    pointer-events: all;
    animation: slideIn 0.2s ease;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: none; }
  }
  .toast-success { border-color: var(--success); }
  .toast-error { border-color: var(--danger); }
  .toast-warning { border-color: var(--warning); }

  .toast-icon { font-size: 14px; flex-shrink: 0; }
  .toast-info .toast-icon { color: var(--accent); }
  .toast-success .toast-icon { color: var(--success); }
  .toast-error .toast-icon { color: var(--danger); }
  .toast-warning .toast-icon { color: var(--warning); }

  .toast-msg { flex: 1; color: var(--text-primary); }
  .toast-dismiss {
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    background: none;
    border: none;
    padding: 2px;
    flex-shrink: 0;
  }
  .toast-dismiss:hover { color: var(--text-primary); }
</style>
