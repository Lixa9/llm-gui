<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import { draftsStore } from '../../stores/drafts.svelte';
  import { api } from '$lib/api';
  import type { ChatPayload, ChatSendResult, UploadResult } from '$lib/types';
  import { fileIcon } from '$lib/fileUtils';
  import { canSubmitComposerDraft, deleteUploadBestEffort, submitComposerDraft } from '$lib/composerSubmission';
  import { toast } from '../ui/Toast.svelte';

  interface Props {
    conversationId: string | null;
    selectedModel: string;
    systemPromptText: string;
    systemPromptId: string | undefined;
    onSend: (payload: ChatPayload, onAccepted?: (conversationId:string) => void) => Promise<ChatSendResult>;
    onStop: () => void;
    streaming: boolean;
    expanded?: boolean;
  }
  let { conversationId, selectedModel, systemPromptText, systemPromptId, onSend, onStop, streaming, expanded = $bindable(false) }: Props = $props();

  const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/tiff', 'image/bmp', 'image/svg+xml']);
  let acceptFormats = $state('');
  let draftKey = $state('');
  let draftReady = $state(false);
  let draftGeneration = 0;
  onMount(()=>{ void api.uploads.formats().then(formats=>{ acceptFormats = formats.flatMap(f=>[f.mime,...f.extensions.map(ext=>`.${ext}`)]).join(','); }).catch(error=>toast((error as Error).message,'error')); });
  const MAX_ATTACHMENTS = 20;
  const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
  const TEXT_MAX_BYTES = 50 * 1024 * 1024;

  interface PendingAttachment {
    id: string;
    localUrl: string;
    filename: string;
    mimeType: string;
    kind: 'image' | 'file';
    status: 'uploading' | 'ready' | 'error';
    result?: UploadResult;
    errorMsg?: string;
    warning?: string;
  }

  let text = $state('');
  let pendingAttachments = $state<PendingAttachment[]>([]);
  let submitting = $state(false);
  let fileInputEl: HTMLInputElement;
  let destroyed = false;
  const discardedAttachmentIds = new Set<string>();

  function discardStoredUpload(uploadId: string): void {
    void deleteUploadBestEffort(uploadId, api.uploads.delete);
  }

  function saveDraft() {
    if(!draftReady || !draftKey)return Promise.resolve();
    return draftsStore.save(draftKey,{text,attachments:pendingAttachments.flatMap(a=>a.result?[a.result]:[])});
  }
  $effect(()=>{
    const key=conversationId ?? 'new';
    untrack(()=>{
      if(draftKey && draftKey!==key)void saveDraft();
      for(const attachment of pendingAttachments){ if(attachment.localUrl.startsWith('blob:'))URL.revokeObjectURL(attachment.localUrl); discardedAttachmentIds.add(attachment.id); }
      draftKey=key;draftReady=false;text='';pendingAttachments=[];
      const generation=++draftGeneration;
      void draftsStore.load(key).then(draft=>{
        if(destroyed || generation!==draftGeneration)return;
        text=draft.text;
        pendingAttachments=draft.attachments.map(result=>({id:crypto.randomUUID(),localUrl:result.kind==='image'?`${result.url}/preview`:'',filename:result.filename,mimeType:result.mime_type,kind:result.kind ?? 'file',status:'ready',result,warning:result.warning}));
        draftReady=true;
      }).catch(error=>{if(generation===draftGeneration){draftReady=true;toast(`Could not load draft: ${(error as Error).message}`,'error');}});
    });
  });
  $effect(()=>{
    const value=text,attachments=pendingAttachments,ready=draftReady,key=draftKey;
    if(!ready || !key)return;
    const timer=setTimeout(()=>{void draftsStore.save(key,{text:value,attachments:attachments.flatMap(a=>a.result?[a.result]:[])});},250);
    return ()=>clearTimeout(timer);
  });
  onDestroy(() => {
    void saveDraft();destroyed=true;
    for(const attachment of pendingAttachments){
      if(attachment.localUrl.startsWith('blob:'))URL.revokeObjectURL(attachment.localUrl);
      discardedAttachmentIds.add(attachment.id);
    }
  });

  function rejectFile(file: File, kind: 'image' | 'file', errorMsg: string) {
    pendingAttachments = [...pendingAttachments, { id: crypto.randomUUID(), localUrl: '', filename: file.name, mimeType: file.type, kind, status: 'error', errorMsg }];
  }

  async function onFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      const kind = ALLOWED_IMAGE_MIMES.has(file.type) ? 'image' : 'file';

      if (pendingAttachments.length >= MAX_ATTACHMENTS) {
        rejectFile(file, kind, `Maximum ${MAX_ATTACHMENTS} attachments per message`);
        continue;
      }

      if (kind === 'image') {
        if (file.size > IMAGE_MAX_BYTES) {
          rejectFile(file, kind, 'File too large (max 20 MB)');
          continue;
        }
      } else if (file.size > TEXT_MAX_BYTES) {
        rejectFile(file, kind, 'File too large (max 50 MB)');
        continue;
      }

      const localUrl = kind === 'image' ? URL.createObjectURL(file) : '';
      const attachment: PendingAttachment = { id: crypto.randomUUID(), localUrl, filename: file.name, mimeType: file.type, kind, status: 'uploading' };
      pendingAttachments = [...pendingAttachments, attachment];
      try {
        const result = await api.uploads.upload(file);
        if (destroyed || discardedAttachmentIds.has(attachment.id)) {
          discardStoredUpload(result.id);
          continue;
        }
        if (localUrl.startsWith('blob:')) URL.revokeObjectURL(localUrl);
        pendingAttachments = pendingAttachments.map(a =>
          a.id === attachment.id ? { ...a, status: 'ready', kind: result.kind ?? a.kind, mimeType: result.mime_type, localUrl: result.kind === 'image' ? `${result.url}/preview` : '', result, warning: result.warning } : a
        );
      } catch (err) {
        if (destroyed || discardedAttachmentIds.has(attachment.id)) continue;
        pendingAttachments = pendingAttachments.map(a =>
          a.id === attachment.id ? { ...a, status: 'error', errorMsg: (err as Error).message } : a
        );
      }
    }
  }

  function removeAttachment(idx: number) {
    const a = pendingAttachments[idx];
    discardedAttachmentIds.add(a.id);
    if (a.localUrl) URL.revokeObjectURL(a.localUrl);
    pendingAttachments = pendingAttachments.filter((_, i) => i !== idx);
    if(a.result?.id)void saveDraft().then(()=>discardStoredUpload(a.result!.id)).catch(()=>{});
  }

  async function send() {
    const trimmed = text.trim();
    const readyAttachments = pendingAttachments.filter(a => a.status === 'ready' && a.result);
    if (!canSend) return;

    const imageParts = readyAttachments
      .filter(a => a.kind === 'image')
      .map(a => ({
        type: 'image_url' as const,
        image_url: { url: a.result!.url },
        _filename: a.result!.filename,
        _mime_type: a.result!.mime_type,
        _warning: a.result!.warning ?? undefined,
      }));

    const fileParts = readyAttachments
      .filter(a => a.kind === 'file')
      .map(a => ({
        type: 'file' as const,
        file: { url: a.result!.url },
        _filename: a.result!.filename,
        _mime_type: a.result!.mime_type,
        _warning: a.result!.warning ?? undefined,
      }));

    const textParts = trimmed ? [{ type: 'text' as const, text: trimmed }] : [];
    const contentParts = [...textParts, ...imageParts, ...fileParts];

    const payload: ChatPayload = {
      conversation_id: conversationId,
      model: selectedModel,
      system_prompt: systemPromptText,
      system_prompt_id: systemPromptId,
      new_user_message: { content: contentParts },
    };

    const submittedDraftKey=draftKey;
    let cleared = false;
    const clearAcceptedDraft = (acceptedConversationId?:string) => {
      if (cleared) return;
      cleared = true;
      if (draftKey===submittedDraftKey || draftKey===acceptedConversationId) {
        for (const attachment of pendingAttachments) {
          if (attachment.localUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.localUrl);
        }
        draftGeneration++; draftReady=true; text=''; pendingAttachments=[];
      }
      void draftsStore.save(submittedDraftKey,{text:'',attachments:[]});
      if(acceptedConversationId && acceptedConversationId!==submittedDraftKey) void draftsStore.save(acceptedConversationId,{text:'',attachments:[]});
      expanded = false;
    };
    submitting = true;
    try {
      await saveDraft();
      await submitComposerDraft(() => onSend(payload,clearAcceptedDraft),clearAcceptedDraft);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (canSend) void send();
    }
  }

  const modelCapabilities=$derived(modelsStore.models.find(m=>m.id===selectedModel)?.capabilities);
  const incompatibleAttachments=$derived(pendingAttachments.some(a=>a.status==='ready' && (
    ((a.kind==='image' || Number(a.result?.coverage?.served_image_count ?? 0)>0) && modelCapabilities?.vision!==true) ||
    (a.result?.coverage?.processing_status==='native_only' && !modelCapabilities?.native_pdf)
  )));
  const canSend = $derived(canSubmitComposerDraft({
    streaming: streaming || !draftReady || incompatibleAttachments,
    submitting,
    hasContent: !!text.trim(),
    hasReadyAttachment: pendingAttachments.some(a => a.status === 'ready'),
    hasUploadingAttachment: pendingAttachments.some(a => a.status === 'uploading'),
    hasModel: !!selectedModel,
  }));
</script>

<div class="composer" class:expanded>
  {#if incompatibleAttachments}<p role="status">Choose a model that supports these images or native PDF attachments.</p>{/if}
  {#if pendingAttachments.length > 0}
    <div class="attachments">
      {#each pendingAttachments as att, i}
        <div class="attachment-chip" class:error={att.status === 'error'} class:warning={att.warning}>
          {#if att.status === 'uploading'}
            <span class="chip-spinner"></span>
          {:else if att.status === 'error'}
            <span class="chip-icon">⚠</span>
          {:else if att.kind === 'image'}
            <img class="chip-thumb" src={att.localUrl} alt={att.filename} />
          {:else}
            <span class="chip-icon">{fileIcon(att.mimeType)}</span>
          {/if}
          {#if att.warning}
            <span class="chip-warn" title={att.warning}>⚠</span>
          {/if}
          <span class="chip-name" title={att.status === 'error' ? att.errorMsg : att.filename}>
            {att.filename}
          </span>
          <button class="chip-remove" onclick={() => removeAttachment(i)} title="Remove" aria-label="Remove" disabled={streaming || submitting || !draftReady}><Icon name="close" size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="composer-row">
    <textarea
      class="composer-textarea"
      bind:value={text}
      placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
      rows={3}
      onkeydown={handleKeydown}
      disabled={streaming || submitting || !draftReady}
    ></textarea>
    <div class="composer-controls">
      <button
        class="icon-btn"
        onclick={() => fileInputEl.click()}
        title="Attach files"
        aria-label="Attach files"
        disabled={streaming || submitting || !draftReady}
      ><Icon name="attach" /></button>
      <button
        class="expand-btn"
        onclick={() => expanded = !expanded}
        title={expanded ? 'Collapse' : 'Expand'}
        aria-label={expanded ? 'Collapse' : 'Expand'}
      ><Icon name={expanded ? 'collapse' : 'expand'} /></button>
      {#if streaming}
        <button class="send-btn stop-btn" onclick={onStop} title="Stop generation"><Icon name="stop" /> <span>Stop</span></button>
      {:else}
        <button class="send-btn" onclick={() => void send()} disabled={!canSend} title="Send">
          <Icon name="send" /> <span>Send</span>
        </button>
      {/if}
    </div>
  </div>
  <input
    bind:this={fileInputEl}
    type="file"
    accept={acceptFormats || undefined}
    multiple
    style="display:none"
    onchange={onFileSelected}
  />
</div>

<style>
  .composer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 10px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }

  .composer.expanded {
    flex: 1;
    min-height: 0;
  }

  .composer-row {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: 8px;
  }

  .expanded .composer-row {
    flex-direction: column;
    flex: 1;
    min-height: 0;
    align-items: stretch;
  }

  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .attachment-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 6px 3px 4px;
    font-size: 12px;
    color: var(--text-secondary);
    max-width: 200px;
  }

  .attachment-chip.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .chip-warn {
    font-size: 12px;
    flex-shrink: 0;
    cursor: default;
    color: #f0a020;
  }

  .chip-thumb {
    width: 28px;
    height: 28px;
    object-fit: cover;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .chip-icon {
    font-size: 14px;
    flex-shrink: 0;
  }

  .chip-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .chip-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 11px;
    padding: 0 1px;
    line-height: 1;
    flex-shrink: 0;
  }
  .chip-remove:hover { color: var(--danger); }

  .composer-textarea {
    flex: 1;
    padding: 9px 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 14px;
    font-family: var(--font-sans);
    line-height: 1.5;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
    min-height: 72px;
    max-height: 240px;
    overflow-y: auto;
  }
  .composer-textarea:focus { border-color: var(--accent); }
  .composer-textarea:disabled { opacity: 0.6; }

  .expanded .composer-textarea {
    flex: 1;
    max-height: none;
    min-height: 0;
  }

  .composer-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .expanded .composer-controls {
    justify-content: flex-end;
  }

  .icon-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: var(--radius-sm);
    font-size: 15px;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.1s, border-color 0.1s;
  }
  .icon-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--text-secondary); }
  .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .expand-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color 0.1s, border-color 0.1s, background 0.1s;
  }
  .expand-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); background: var(--bg-hover); }

  .send-btn {
    gap: 6px;
    padding: 9px 16px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s, opacity 0.1s;
    flex-shrink: 0;
    height: 40px;
  }
  .send-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stop-btn { background: var(--danger); }
  .stop-btn:hover { background: var(--danger-hover); }
</style>
