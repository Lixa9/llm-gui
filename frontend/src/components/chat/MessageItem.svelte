<script lang="ts">
  import { centerInlineText } from '$lib/controlTextAlignment';
  import ControlLabel from '../ui/ControlLabel.svelte';
  import type { Message } from '$lib/types';
  import type { PendingMessage } from '../../stores/chat.svelte';
  import MessageContent from './MessageContent.svelte';
  import MessageActions from './MessageActions.svelte';
  import MessageEditor from './MessageEditor.svelte';
  import StreamingCursor from './StreamingCursor.svelte';
  import Badge from '../ui/Badge.svelte';
  import { extractTextFromContent, formatRelativeDate } from '$lib/utils';
  import { messageEditsStore } from '../../stores/messageEdits.svelte';
  import { modelsStore } from '../../stores/models.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';

  interface Props {
    message: Message | PendingMessage;
    conversationId?: string;
    isStreaming?: boolean;
    isPending?: boolean;
    onSave: (msg: Message, content: string) => Promise<void>;
    onRegenerate: (msg: Message) => void;
    onDelete: (msg: Message) => void;
    onFork: (msg: Message) => void;
  }
  let { message, conversationId, isStreaming = false, isPending = false, onSave, onRegenerate, onDelete, onFork }: Props = $props();

  const isFullMessage = $derived('id' in message && !isPending);
  const isPersistedStreaming = $derived(isFullMessage && (message as Message).status === 'streaming');
  const isActionable = $derived(isFullMessage && !isPersistedStreaming && !(message as Message).delivery_status);
  const editConversationId = $derived(isFullMessage ? (message as Message).conversation_id : undefined);
  const editDraft = $derived(editConversationId ? messageEditsStore.get(editConversationId, (message as Message).id) : undefined);



  const content = $derived(
    isPending
      ? [{ type: 'text' as const, text: (message as PendingMessage).content }]
      : (message as Message).content,
  );

  const senderName = $derived.by((): string => {
    if (message.role !== 'assistant') return 'You';
    const convId = isPending ? conversationId : (message as Message).conversation_id;
    if (convId) {
      const conv = conversationsStore.list.find(c => c.id === convId);
      if (conv?.preset_id) {
        const preset = modelsStore.presets.find(p => p.id === conv.preset_id);
        if (preset?.name) return preset.name;
      }
    }
    const modelId = isPending
      ? (message as PendingMessage).model
      : (message as Message).model;
    if (modelId) {
      const modelInfo = modelsStore.models.find(m => m.id === modelId);
      return modelInfo?.display_name ?? modelId;
    }
    return 'Assistant';
  });
</script>

<div class="msg-wrapper" class:msg-user={message.role === 'user'} class:msg-assistant={message.role === 'assistant'} class:editing={editDraft !== undefined}>
  <div class="msg-avatar">
    {#if message.role === 'user'}
      <div class="avatar user-avatar"><ControlLabel>U</ControlLabel></div>
    {:else}
      <div class="avatar ai-avatar"><ControlLabel>AI</ControlLabel></div>
    {/if}
  </div>

  <div class="msg-body">
    <div class="msg-header">
      <span class="msg-role" use:centerInlineText>{senderName}</span>
      {#if isFullMessage}
        {#if (message as Message).edited_at}
          <Badge variant="muted">edited</Badge>
        {/if}
        {#if (message as Message).status === 'aborted'}
          <Badge variant="warning">stopped</Badge>
        {:else if (message as Message).status === 'timed_out'}
          <Badge variant="warning">timed out</Badge>
        {:else if (message as Message).status === 'failed'}
          <Badge variant="warning">failed</Badge>
        {/if}
        {#if (message as Message).delivery_status === 'sending'}
          <Badge variant="muted">sending</Badge>
        {:else if (message as Message).delivery_status === 'failed'}
          <Badge variant="warning">not sent</Badge>
        {:else if (message as Message).delivery_status === 'uncertain'}
          <Badge variant="warning">unverified</Badge>
        {/if}
        <span class="msg-time" use:centerInlineText>{formatRelativeDate((message as Message).timestamp)}</span>
      {/if}
    </div>



    {#if isFullMessage && message.role === 'assistant' && ['aborted', 'timed_out', 'failed'].includes((message as Message).status ?? '')}
      <p class="incomplete-notice">This incomplete response will not be included in subsequent requests.</p>
    {/if}

    {#if isActionable && editConversationId && editDraft !== undefined}
      <MessageContent role={message.role} content={content.filter(part => part.type !== 'text')} />
      <MessageEditor
        message={message as Message}
        value={editDraft}
        disabled={isStreaming}
        onchange={(value) => messageEditsStore.set(editConversationId!, (message as Message).id, value)}
        oncancel={() => messageEditsStore.remove(editConversationId!, (message as Message).id)}
        onsave={onSave}
      />
    {:else}
      <MessageContent
        role={message.role}
        {content}
        streaming={(isPending || isPersistedStreaming) && isStreaming}
        streamingText={isPending ? (message as PendingMessage).content : undefined}
      />
    {/if}

    {#if (isPending || isPersistedStreaming) && isStreaming}
      <StreamingCursor />
    {/if}

    {#if isActionable && editDraft === undefined}
      <MessageActions
        message={message as Message}
        {isStreaming}
        onEdit={() => messageEditsStore.set(editConversationId!, (message as Message).id, extractTextFromContent(content))}
        onRegenerate={() => onRegenerate(message as Message)}
        onDelete={() => onDelete(message as Message)}
        onFork={() => onFork(message as Message)}
      />
    {/if}
  </div>
</div>

<style>
  .msg-wrapper {
    display: flex;
    gap: 12px;
    padding: 10px 16px;
    border-radius: var(--radius);
  }
  .msg-user { flex-direction: row-reverse; }
  .msg-user .msg-body {
    flex: 0 1 auto;
    max-width: 72%;
    align-items: flex-end;
  }
  .msg-user .msg-header { flex-direction: row-reverse; }
  .msg-user.editing .msg-body { flex: 1; }
  .msg-assistant .msg-body { flex: 1; min-width: 0; }

  .msg-avatar { flex-shrink: 0; padding-top: 2px; }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .user-avatar { background: var(--bg-elevated); color: var(--text-secondary); }
  .ai-avatar { background: var(--accent-subtle); color: var(--accent); }

  .msg-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

  .msg-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .incomplete-notice { font-size: 12px; color: var(--text-muted); margin: 4px 0 8px; }
  .msg-role { font-size: 13px; font-weight: 600; }
  .msg-time { font-size: 11px; color: var(--text-muted); }

</style>
