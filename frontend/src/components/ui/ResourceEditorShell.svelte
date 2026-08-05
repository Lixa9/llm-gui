<script lang="ts">
  interface Props {
    headingId: string;
    title: string;
    description: string;
    onsubmit: (event: SubmitEvent) => void;
    children: import('svelte').Snippet;
    actions: import('svelte').Snippet;
  }

  let { headingId, title, description, onsubmit, children, actions }: Props = $props();
</script>

<section class="editor-panel" aria-labelledby={headingId}>
  <div class="editor-header">
    <h3 id={headingId}>{title}</h3>
    <p>{description}</p>
  </div>
  <form class="editor-form" onsubmit={onsubmit}>
    <div class="editor-body">
      {@render children()}
    </div>
    <div class="actions">
      {@render actions()}
    </div>
  </form>
</section>

<style>
  .editor-panel {
    min-width: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .editor-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .editor-header h3 { font-size: 15px; }
  .editor-header p { margin-top: 4px; color: var(--text-muted); font-size: 12px; line-height: 1.4; }

  .editor-form { display: flex; flex-direction: column; }
  .editor-body { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 16px 16px; }
</style>
