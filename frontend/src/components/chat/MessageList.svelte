<script lang="ts">
  import MessageItem from './MessageItem.svelte';
  import type { Message } from '$lib/types';
  import type { PendingMessage } from '../../stores/chat.svelte';
  import { chatStore } from '../../stores/chat.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { navigateTo } from '$lib/router';

  interface Props {
    conversationId: string;
    onEdit: (msg: Message) => void;
    onRegenerate: (msg: Message) => void;
  }
  let { conversationId, onEdit, onRegenerate }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let atBottom = $state(true);

  function scrollToBottom() {
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  }

  $effect(() => {
    chatStore.allMessages.length;
    chatStore.pending?.content?.length;
    if (atBottom) setTimeout(scrollToBottom, 0);
  });

  function onScroll() {
    if (!container) return;
    atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  async function handleDelete(msg: Message) {
    await chatStore.deleteMessage(conversationId, msg.id);
  }

  async function handleFork(msg: Message) {
    const forked = await conversationsStore.fork(conversationId, msg.id);
    conversationsStore.setActive(forked.id);
    navigateTo('chat', forked.id);
  }
</script>

<div class="message-list" bind:this={container} onscroll={onScroll}>
  {#if chatStore.loadingMessages}
    <div class="list-center"><Spinner /></div>
  {:else if chatStore.allMessages.length === 0}
    <div class="list-empty">
      <div class="list-empty-icon">💬</div>
      <p>Start a conversation</p>
    </div>
  {:else}
    {#each chatStore.allMessages as message, i (('id' in message ? message.id : `pending-${i}`))}
      <MessageItem
        {message}
        {conversationId}
        isStreaming={chatStore.streaming}
        isPending={!('id' in message)}
        {onEdit}
        onRegenerate={onRegenerate}
        onDelete={handleDelete}
        onFork={handleFork}
      />
    {/each}

    {#if chatStore.error}
      <div class="stream-error">⚠ {chatStore.error}</div>
    {/if}
  {/if}
</div>

<style>
  .message-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 8px 0;
  }

  .list-center {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }

  .list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: 8px;
  }
  .list-empty-icon { font-size: 40px; opacity: 0.4; }
  .list-empty p { font-size: 14px; }

  .stream-error {
    margin: 8px 16px;
    padding: 10px 14px;
    background: rgba(224, 82, 82, 0.08);
    border: 1px solid rgba(224, 82, 82, 0.3);
    border-radius: var(--radius-sm);
    color: var(--danger);
    font-size: 13px;
  }
</style>
