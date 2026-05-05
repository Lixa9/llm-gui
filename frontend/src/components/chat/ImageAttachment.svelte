<script lang="ts">
  import { api } from '$lib/api';
  import { toast } from '../ui/Toast.svelte';

  interface Props {
    urls?: string[];
    onAdd: (url: string) => void;
    onRemove: (url: string) => void;
  }
  let { urls = [], onAdd, onRemove }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let dragOver = $state(false);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    uploading = true;
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) {
          toast('Only image files are supported', 'error');
          continue;
        }
        const { url } = await api.uploads.upload(file);
        onAdd(url);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      uploading = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }
</script>

<div
  class="attach-zone"
  class:drag-over={dragOver}
  role="region"
  aria-label="Image attachments"
  ondragover={(e) => { e.preventDefault(); dragOver = true; }}
  ondragleave={() => dragOver = false}
  ondrop={onDrop}
>
  {#if urls.length > 0}
    <div class="thumbs">
      {#each urls as url}
        <div class="thumb-wrap">
          <img src={url} alt="attachment" class="thumb" />
          <button class="thumb-remove" onclick={() => onRemove(url)} title="Remove">✕</button>
        </div>
      {/each}
    </div>
  {/if}

  <button
    class="attach-btn"
    onclick={() => fileInput?.click()}
    disabled={uploading}
    title="Attach image"
  >
    {uploading ? '⏳' : '📎'}
  </button>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="sr-only"
    onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
  />
</div>

<style>
  .attach-zone {
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s;
  }
  .attach-zone.drag-over { background: var(--accent-subtle); border-radius: var(--radius-sm); }

  .thumbs { display: flex; flex-wrap: wrap; gap: 4px; }
  .thumb-wrap { position: relative; }
  .thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); }
  .thumb-remove {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 9px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .thumb-remove:hover { background: var(--danger); color: #fff; border-color: var(--danger); }

  .attach-btn {
    padding: 5px 7px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 15px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .attach-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-secondary); }
  .attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
