<script lang="ts">
  interface Props {
    open?: boolean;
    header: import('svelte').Snippet;
    children: import('svelte').Snippet;
  }
  let { open = $bindable(false), header, children }: Props = $props();
</script>

<div class="accordion">
  <button
    class="accordion-header"
    onclick={() => open = !open}
    aria-expanded={open}
  >
    {@render header()}
    <svg 
      class="accordion-chevron" 
      class:open 
      width="16" 
      height="16" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      stroke-width="2" 
      stroke-linecap="round" 
      stroke-linejoin="round"
    >
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  </button>
  <div class="accordion-content-wrapper" style="height: {open ? 'auto' : '0px'}">
    <div class="accordion-content">
      {@render children()}
    </div>
  </div>
</div>
