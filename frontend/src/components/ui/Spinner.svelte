<script lang="ts">
  interface Props { size?: number; }
  let { size = 20 }: Props = $props();
</script>

<span class="spinner" style="width:{size}px;height:{size}px"></span>

<style>
  .spinner {
    display: inline-block;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
