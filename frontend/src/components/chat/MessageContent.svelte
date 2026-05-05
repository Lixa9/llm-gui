<script lang="ts">
  import { renderMarkdown } from '$lib/markdown';
  import type { MessageContentPart } from '$lib/types';

  interface Props {
    role: string;
    content: MessageContentPart[];
    streaming?: boolean;
    streamingText?: string;
  }
  let { role, content, streaming = false, streamingText }: Props = $props();

  const text = $derived(
    streaming && streamingText != null
      ? streamingText
      : content.filter(p => p.type === 'text').map(p => p.text).join('\n'),
  );

  const rendered = $derived(role === 'assistant' ? renderMarkdown(text) : null);
</script>

<div class="msg-content" class:user={role === 'user'} class:assistant={role === 'assistant'}>
  {#if role === 'assistant'}
    <div class="prose" class:streaming>{@html rendered}</div>
  {:else}
    <span class="user-text">{text}</span>
  {/if}
</div>

<style>
  .msg-content { max-width: 100%; min-width: 0; }

  .msg-content.user {
    background: var(--accent-subtle);
    border: 1px solid rgba(124, 106, 247, 0.2);
    border-radius: var(--radius);
    padding: 8px 12px;
  }

  .user-text { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6; }
  .prose { font-size: 14px; }
</style>
