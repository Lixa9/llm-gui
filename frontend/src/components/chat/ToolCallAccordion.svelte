<script lang="ts">
  import type { ToolCall } from '$lib/types';
  import Accordion from '../ui/Accordion.svelte';

  interface Props {
    toolCall: ToolCall;
    showByDefault?: boolean;
  }
  let { toolCall, showByDefault = false }: Props = $props();

  // svelte-ignore state_referenced_locally
  let open = $state(showByDefault);

  const argsPreview = $derived(() => {
    try {
      const s = JSON.stringify(toolCall.arguments);
      return s.length > 80 ? s.slice(0, 80) + '…' : s;
    } catch {
      return String(toolCall.arguments);
    }
  });

  const argsPretty = $derived(() => {
    try { return JSON.stringify(toolCall.arguments, null, 2); }
    catch { return String(toolCall.arguments); }
  });
</script>

<div class="tool-call">
  <Accordion bind:open>
    {#snippet header()}
      <span class="tool-name">{toolCall.name}</span>
      {#if !open}
        <span class="tool-preview">{argsPreview()}</span>
      {/if}
    {/snippet}
    {#snippet children()}
      <div class="tool-body">
        <div class="tool-section-label">Arguments</div>
        <pre class="tool-json">{argsPretty()}</pre>
      </div>
    {/snippet}
  </Accordion>
</div>

<style>
  .tool-call { margin: 4px 0; }
  .tool-name { color: var(--accent); font-weight: 600; }
  .tool-preview { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

  .tool-body { display: flex; flex-direction: column; gap: 4px; }
  .tool-section-label { font-size: 10px; color: var(--text-muted); letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 0 2px; }
  .tool-json {
    margin: 0;
    padding: 8px;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
