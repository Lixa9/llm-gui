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
      : content
          .filter((p): p is import('$lib/types').ContentPart => p.type === 'text')
          .map(p => p.text)
          .join('\n'),
  );

  const images = $derived(
    content.filter((p): p is import('$lib/types').ImageContentPart =>
      p.type === 'image_url' && (
        p.image_url.url.startsWith('/') ||
        /^https?:\/\//.test(p.image_url.url) ||
        p.image_url.url.startsWith('data:image/')
      )
    ),
  );

  const rendered = $derived(role === 'assistant' ? renderMarkdown(text) : null);
</script>

<div class="msg-content" class:user={role === 'user'} class:assistant={role === 'assistant'}>
  {#if role === 'assistant'}
    <div class="prose" class:streaming>{@html rendered}</div>
  {:else}
    {#if images.length > 0}
      <div class="image-grid">
        {#each images as img}
          <img src={img.image_url.url} alt="attachment" class="msg-image" />
        {/each}
      </div>
    {/if}
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
  .image-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .msg-image { max-width: 280px; max-height: 200px; border-radius: var(--radius-sm); object-fit: cover; cursor: pointer; }
  .prose { font-size: 14px; }
</style>
