<script lang="ts">
  import { api } from '$lib/api';
  import { renderMarkdown } from '$lib/markdown';
  import { createRenderScheduler } from '$lib/renderScheduler';
  import { onDestroy, untrack } from 'svelte';
  import type { MessageContentPart, ImageUrlPart, FilePart } from '$lib/types';
  import { fileIcon } from '$lib/fileUtils';

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
    content.filter((p): p is ImageUrlPart => p.type === 'image_url')
  );

  const fileParts = $derived(
    content.filter((p): p is FilePart => p.type === 'file')
  );

const text = $derived(
    streaming && streamingText != null
      ? streamingText
      : textParts.map(p => p.text).join('\n'),
  );

  let rendered = $state(untrack(() => role === 'assistant' ? renderMarkdown(text) : ''));
  const render = createRenderScheduler(value => { rendered = renderMarkdown(value); });
  $effect(() => {
    const value = text;
    const active = streaming;
    if (role === 'assistant') untrack(() => render.update(value, active));
  });
  onDestroy(() => render.destroy());

  let coverage=$state<{warning?:string;page_count?:number;served_pages?:number;sheet_names?:string[];entries?:Array<{name:string;status:string;reason?:string}>;error?:string}|null>(null);
  async function showCoverage(url:string){try{const result=await api.uploads.metadata(url.split('/').pop()!);coverage=result.coverage;}catch(error){coverage={error:(error as Error).message};}}
  let lightboxSrc = $state<string | null>(null);

  function onProseClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('pre code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent ?? '').then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  }
</script>

{#if lightboxSrc}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox-overlay" onclick={() => lightboxSrc = null}>
    <img class="lightbox-img" src={lightboxSrc} alt="Full size" />
  </div>
{/if}

{#if coverage}
  <div class="coverage-panel" aria-label="Attachment coverage">
    <button onclick={()=>coverage=null}>Close coverage</button>
    {#if coverage.error}<p>{coverage.error}</p>{:else}
      {#if coverage.page_count}<p>Included {coverage.served_pages ?? coverage.page_count} of {coverage.page_count} pages.</p>{/if}
      {#if coverage.sheet_names?.length}<p>Sheets: {coverage.sheet_names.join(', ')}</p>{/if}
      {#if coverage.warning}<p>{coverage.warning}</p>{:else}<p>Processed successfully within the attachment limits.</p>{/if}
      {#if coverage.entries?.length}<ul>{#each coverage.entries as entry}<li>{entry.name}: {entry.status}{entry.reason ? ` — ${entry.reason}` : ''}</li>{/each}</ul>{/if}
    {/if}
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
          src={img.image_url.url.startsWith('/api/uploads/') ? `${img.image_url.url}/preview` : img.image_url.url}
          alt={img._filename ?? 'attached image'}
          title={img._warning ?? img._filename}
          onclick={() => lightboxSrc = img.image_url.url.startsWith('/api/uploads/') ? `${img.image_url.url}/preview` : img.image_url.url}
        />
        {#if img.image_url.url.startsWith('/api/uploads/')}<a href={img.image_url.url} download={img._filename}>Download original</a><button onclick={()=>void showCoverage(img.image_url.url)}>Coverage</button>{/if}
        {#if img._warning}<span class="coverage-warning">{img._warning}</span>{/if}
      {/each}
    </div>
  {/if}
  {#if fileParts.length > 0}
    <div class="file-parts">
      {#each fileParts as fp}
        <a class="file-chip" href={fp.file.url} download={fp._filename} title={fp._warning ?? fp._filename}>
          {fileIcon(fp._mime_type)}&nbsp;{fp._filename ?? 'Attached file'}
        </a>
        {#if fp.file.url.startsWith('/api/uploads/')}<button onclick={()=>void showCoverage(fp.file.url)}>Coverage</button>{/if}
        {#if fp._warning}<span class="coverage-warning">{fp._warning}</span>{/if}
      {/each}
    </div>
  {/if}
  {#if role === 'assistant'}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="prose" class:streaming onclick={onProseClick}>{@html rendered}</div>
  {:else if text}
    <span class="user-text">{text}</span>
  {/if}
</div>

<style>
  .coverage-panel { font-size:12px; max-height:300px; overflow:auto; }
  .coverage-warning { font-size:12px; color:var(--text-secondary); }
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

  .file-parts {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
  }

  .file-chip {
    display: inline-flex;
    align-items: center;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 2px 7px;
    font-size: 12px;
    color: var(--text-secondary);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-text { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.6; }
  .prose { font-size: 14px; }
</style>
