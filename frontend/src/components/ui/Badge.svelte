<script lang="ts">
  import ControlLabel from './ControlLabel.svelte';
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

<span class="badge {classMap[variant]}"><ControlLabel>{@render children()}</ControlLabel></span>
