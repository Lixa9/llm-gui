<script lang="ts">
  interface Props {
    variant?: 'default' | 'accent' | 'success' | 'danger' | 'warning' | 'muted';
    children: import('svelte').Snippet;
  }
  let { variant = 'default', children }: Props = $props();
</script>

<span class="badge badge-{variant}">{@render children()}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .badge-default { background: var(--bg-elevated); color: var(--text-secondary); }
  .badge-accent { background: var(--accent-subtle); color: var(--accent); }
  .badge-success { background: rgba(76, 175, 120, 0.12); color: var(--success); }
  .badge-danger { background: rgba(224, 82, 82, 0.12); color: var(--danger); }
  .badge-warning { background: rgba(224, 160, 80, 0.12); color: var(--warning); }
  .badge-muted { background: transparent; color: var(--text-muted); }
</style>
