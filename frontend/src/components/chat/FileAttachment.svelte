<script lang="ts">
  import { api } from '$lib/api'; // still used for image uploads
  import { toast } from '../ui/Toast.svelte';
  import type { Attachment } from '$lib/types';

  interface Props {
    attachments?: Attachment[];
    onAdd: (a: Attachment) => void;
    onRemove: (name: string) => void;
  }
  let { attachments = [], onAdd, onRemove }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let dragOver = $state(false);

  const TEXT_EXTENSIONS = new Set([
    'txt','md','csv','json','xml','html','htm','yaml','yml','toml','ini','log',
    'py','js','ts','jsx','tsx','css','scss','sh','bash','go','rs','java','c','cpp','h','rb','php',
  ]);

  const BINARY_DOCUMENT_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    'application/msword',           // .doc
    'application/vnd.ms-excel',     // .xls
    'application/vnd.ms-powerpoint',// .ppt
    'application/vnd.oasis.opendocument.text',         // .odt
    'application/vnd.oasis.opendocument.spreadsheet',  // .ods
    'application/vnd.oasis.opendocument.presentation', // .odp
  ]);

  const BINARY_EXTENSIONS = new Set([
    'pdf','docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp',
  ]);

  const MAX_TEXT_BYTES = 512 * 1024;   // 512 KB

  function isTextFile(file: File): boolean {
    if (file.type.startsWith('text/')) return true;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    return TEXT_EXTENSIONS.has(ext);
  }

  function isBinaryDocument(file: File): boolean {
    if (BINARY_DOCUMENT_TYPES.has(file.type)) return true;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    return BINARY_EXTENSIONS.has(ext);
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    uploading = true;
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          const { url } = await api.uploads.upload(file);
          onAdd({ type: 'image', name: file.name, url });
        } else if (isTextFile(file)) {
          if (file.size > MAX_TEXT_BYTES) {
            toast(`${file.name} is too large (max 512 KB for text files)`, 'error');
            continue;
          }
          const content = await readText(file);
          onAdd({ type: 'text_file', name: file.name, content });
        } else if (isBinaryDocument(file)) {
          onAdd({ type: 'file', name: file.name });
        } else {
          toast(`Unsupported file type: ${file.name}`, 'error');
        }
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      uploading = false;
    }
  }

  function readText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
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
  aria-label="File attachments"
  ondragover={(e) => { e.preventDefault(); dragOver = true; }}
  ondragleave={() => dragOver = false}
  ondrop={onDrop}
>
  {#if attachments.length > 0}
    <div class="chips">
      {#each attachments as att}
        {#if att.type === 'image'}
          <div class="thumb-wrap">
            <img src={att.url} alt={att.name} class="thumb" />
            <button class="chip-remove" onclick={() => onRemove(att.name)} title="Remove">✕</button>
          </div>
        {:else}
          <div class="file-chip">
            <span class="chip-icon">{att.type === 'file' ? '📄' : '📝'}</span>
            <span class="chip-name">{att.name}</span>
            <button class="chip-remove inline" onclick={() => onRemove(att.name)} title="Remove">✕</button>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <button
    class="attach-btn"
    onclick={() => fileInput?.click()}
    disabled={uploading}
    title="Attach file"
  >
    {uploading ? '⏳' : '📎'}
  </button>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*,.pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.odt,.ods,.odp,text/*,.md,.yaml,.yml,.toml,.csv,.json,.py,.ts,.tsx,.js,.jsx,.go,.rs,.sh"
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

  .chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

  /* Image thumbnail */
  .thumb-wrap { position: relative; }
  .thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); display: block; }

  /* File chip */
  .file-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--text-secondary);
    max-width: 160px;
  }
  .chip-icon { flex-shrink: 0; }
  .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Remove button — two variants */
  .chip-remove {
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
    flex-shrink: 0;
  }
  .chip-remove:not(.inline) { position: absolute; top: -4px; right: -4px; }
  .chip-remove:hover { background: var(--danger); color: #fff; border-color: var(--danger); }

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
