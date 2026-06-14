<script lang="ts">
  interface Props {
    variant?: 'default' | 'accent' | 'success' | 'danger' | 'warning' | 'muted';
    children: import('svelte').Snippet;
  }
  let { variant = 'default', children }: Props = $props();

  const classMap = {
    default: 'badge-outline',
    accent: 'badge-primary',
    success: 'badge-success',
    danger: 'badge-danger',
    warning: 'badge-warning',
    muted: 'badge-muted'
  };
</script>

<span class="badge {classMap[variant]}">{@render children()}</span>
