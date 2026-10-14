<script lang="ts">
  import { centerLabelText } from '$lib/controlTextAlignment';
  interface Props {
    children: import('svelte').Snippet;
  }
  let { children }: Props = $props();
</script>

<span class="control-label"><span class="control-label-text" use:centerLabelText>{@render children()}</span></span>
