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

  const textParts = $derived(
    content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
  );

  const imageParts = $derived(
    content.filter((p): p is { type: 'image_url'; image_url: { url: string }; _filename?: string } => p.type === 'image_url')
  );

  const text = $derived(
    streaming && streamingText != null
      ? streamingText
      : textParts.map(p => p.text).join('\n'),
  );

  const rendered = $derived(role === 'assistant' ? renderMarkdown(text) : null);

  let lightboxSrc = $state<string | null>(null);
</script>

{#if lightboxSrc}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox-overlay" onclick={() => lightboxSrc = null}>
    <img class="lightbox-img" src={lightboxSrc} alt="Full size" />
  </div>
{/if}

<div class="msg-content" class:user={role === 'user'} class:assistant={role === 'assistant'}>
  {#if imageParts.length > 0}
    <div class="image-parts">
      {#each imageParts as img}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <img
          class="msg-image"
          src={img.image_url.url}
          alt={img._filename ?? 'attached image'}
          title={img._filename}
          onclick={() => lightboxSrc = img.image_url.url}
        />
      {/each}
    </div>
  {/if}
  {#if role === 'assistant'}
    <div class="prose" class:streaming>{@html rendered}</div>
  {:else if text}
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

  .image-parts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .msg-image {
    max-width: 400px;
    max-height: 300px;
    border-radius: var(--radius-sm);
    object-fit: contain;
    cursor: zoom-in;
    border: 1px solid var(--border);
  }

  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    cursor: zoom-out;
  }

  .lightbox-img {
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    border-radius: var(--radius);
  }

  .user-text { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6; }
  .prose { font-size: 14px; }
</style>
