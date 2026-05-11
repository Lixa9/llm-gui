<script lang="ts">
  import type { Message } from '$lib/types';
  import type { PendingMessage } from '../../stores/chat.svelte';
  import MessageContent from './MessageContent.svelte';
  import MessageActions from './MessageActions.svelte';
  import ToolCallAccordion from './ToolCallAccordion.svelte';
  import StreamingCursor from './StreamingCursor.svelte';
  import Badge from '../ui/Badge.svelte';
  import { formatRelativeDate } from '$lib/utils';
  import { modelsStore } from '../../stores/models.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';

  interface Props {
    message: Message | PendingMessage;
    conversationId?: string;
    isStreaming?: boolean;
    isPending?: boolean;
    onEdit: (msg: Message) => void;
    onRegenerate: (msg: Message) => void;
    onDelete: (msg: Message) => void;
    onFork: (msg: Message) => void;
  }
  let { message, conversationId, isStreaming = false, isPending = false, onEdit, onRegenerate, onDelete, onFork }: Props = $props();

  const isFullMessage = $derived('id' in message && !isPending);

  const showToolCalls = $derived(() => {
    if (!('tool_calls' in message) || !message.tool_calls?.length) return false;
    if (isPending) return true;
    const fullMsg = message as Message;
    const model = fullMsg.model;
    if (!model) return true;
    const modelInfo = modelsStore.models.find(m => m.id === model);
    return modelInfo?.show_tool_calls ?? true;
  });

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

<div class="msg-wrapper" class:msg-user={message.role === 'user'} class:msg-assistant={message.role === 'assistant'}>
  <div class="msg-avatar">
    {#if message.role === 'user'}
      <div class="avatar user-avatar">U</div>
    {:else}
      <div class="avatar ai-avatar">AI</div>
    {/if}
  </div>

  <div class="msg-body">
    <div class="msg-header">
      <span class="msg-role">{senderName}</span>
      {#if isFullMessage}
        {#if (message as Message).edited_at}
          <Badge variant="muted">edited</Badge>
        {/if}
        {#if (message as Message).status === 'aborted'}
          <Badge variant="warning">stopped</Badge>
        {/if}
        <span class="msg-time">{formatRelativeDate((message as Message).timestamp)}</span>
      {/if}
    </div>

    {#if showToolCalls() && message.tool_calls?.length}
      <div class="tool-calls">
        {#each message.tool_calls as tc (tc.index)}
          <ToolCallAccordion
            toolCall={tc}
            toolResult={isFullMessage ? ((message as Message).tool_results?.find(r => r.tool_call_id === tc.id) ?? null) : null}
          />
        {/each}
      </div>
    {/if}

    <MessageContent
      role={message.role}
      {content}
      streaming={isPending && isStreaming}
      streamingText={isPending ? (message as PendingMessage).content : undefined}
    />

    {#if isPending && isStreaming}
      <StreamingCursor />
    {/if}

    {#if isFullMessage}
      <MessageActions
        message={message as Message}
        {isStreaming}
        onEdit={() => onEdit(message as Message)}
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
  .msg-role { font-size: 13px; font-weight: 600; }
  .msg-time { font-size: 11px; color: var(--text-muted); }

  .tool-calls { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
</style>
