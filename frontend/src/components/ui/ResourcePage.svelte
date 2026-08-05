<script lang="ts">
  interface Props {
    title: string;
    subtitle: string;
    children: import('svelte').Snippet;
    editor: import('svelte').Snippet;
  }

  let { title, subtitle, children, editor }: Props = $props();
</script>

<div class="view">
  <div class="view-content">
    <header class="view-header">
      <h2 class="view-title">{title}</h2>
      <p class="view-subtitle">{subtitle}</p>
    </header>
    {@render children()}
  </div>
  {@render editor()}
</div>

<style>
  .view {
    min-height: 100%;
    padding: 24px;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }

  .view-content,
  :global(.editor-panel) {
    width: min(100%, 1000px);
  }

  .view-content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .view-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .view-title { font-size: 20px; font-weight: 600; }
  .view-subtitle { font-size: 13px; color: var(--text-muted); }

  @media (max-width: 820px) {
    .view { padding: 16px; }
  }
</style>
