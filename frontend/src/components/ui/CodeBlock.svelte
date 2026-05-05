<script lang="ts">
  import { toast } from './Toast.svelte';

  interface Props { code: string; lang?: string; }
  let { code, lang }: Props = $props();

  async function copy() {
    await navigator.clipboard.writeText(code);
    toast('Copied!', 'success', 1500);
  }
</script>

<div class="code-block">
  {#if lang}
    <div class="code-header">
      <span class="code-lang">{lang}</span>
      <button class="code-copy" onclick={copy} title="Copy code">Copy</button>
    </div>
  {:else}
    <button class="code-copy code-copy-bare" onclick={copy} title="Copy code">Copy</button>
  {/if}
  <pre><code>{code}</code></pre>
</div>

<style>
  .code-block {
    position: relative;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin: 0.75em 0;
  }
  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }
  .code-lang { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
  .code-copy {
    font-size: 11px;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
  }
  .code-copy:hover { color: var(--text-primary); background: var(--bg-hover); }
  .code-copy-bare {
    position: absolute;
    top: 6px;
    right: 8px;
  }
  pre {
    margin: 0;
    padding: 12px 16px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
  }
  code {
    font-family: var(--font-mono);
    background: none;
    border: none;
    padding: 0;
  }
</style>
