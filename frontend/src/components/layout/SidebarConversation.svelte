<script lang="ts">
  import ContextMenu from '../ui/ContextMenu.svelte';
  import type { MenuItem } from '../ui/ContextMenu.svelte';
  import type { Conversation } from '$lib/types';
  import { conversationsStore } from '../../stores/conversations.svelte';
  import { truncateTitle } from '$lib/utils';
  import { navigateTo } from '$lib/router';

  interface Props { conversation: Conversation; }
  let { conversation }: Props = $props();

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let renaming = $state(false);
  let renameValue = $state('');

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    menuX = e.clientX;
    menuY = e.clientY;
    menuOpen = true;
  }

  const isActive = $derived(conversationsStore.activeId === conversation.id);

  function navigate() {
    conversationsStore.setActive(conversation.id);
    conversationsStore.setActiveFolder(conversation.folder_id);
    navigateTo('chat', conversation.id);
  }

  function ondragstart(e: DragEvent) {
    e.dataTransfer?.setData('text/plain', conversation.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    conversationsStore.setDragging(conversation.id);
  }

  function ondragend() {
    conversationsStore.setDragging(null);
  }

  function startRename() {
    renameValue = conversation.title;
    renaming = true;
    menuOpen = false;
  }

  async function finishRename() {
    if (renameValue.trim() && renameValue !== conversation.title) {
      await conversationsStore.rename(conversation.id, renameValue.trim());
    }
    renaming = false;
  }

  function folderLabel(folderId: string): string {
    const parts: string[] = [];
    let current = conversationsStore.folders.find(f => f.id === folderId);
    for (let depth = 0; current && depth < 100; depth++) {
      parts.unshift(current.name);
      current = current.parent_id ? conversationsStore.folders.find(f => f.id === current!.parent_id) : undefined;
    }
    return parts.join(' / ');
  }

  const menuItems = $derived<MenuItem[]>([
    { label: conversation.pinned ? 'Unpin' : 'Pin', icon: '📌', action: () => conversationsStore.pin(conversation.id, !conversation.pinned) },
    { label: 'Rename', icon: '✏', action: startRename },
    { label: 'Move to: No folder', icon: '⊘', disabled: conversation.folder_id === null, action: () => conversationsStore.move(conversation.id, null) },
    ...conversationsStore.folders.map(folder => ({
      label: `Move to: ${folderLabel(folder.id)}`,
      icon: '📁',
      disabled: conversation.folder_id === folder.id,
      action: () => conversationsStore.move(conversation.id, folder.id),
    })),
    { label: 'Duplicate', icon: '⎘', action: () => conversationsStore.duplicate(conversation.id) },
    { label: 'Delete', icon: '🗑', danger: true, action: () => conversationsStore.remove(conversation.id) },
  ]);
</script>

{#if renaming}
  <form onsubmit={(e) => { e.preventDefault(); finishRename(); }}>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="rename-input"
      bind:value={renameValue}
      autofocus
      onblur={finishRename}
      onkeydown={(e) => { if (e.key === 'Escape') { renaming = false; } }}
    />
  </form>
{:else}
  <div
    class="conv-item"
    class:active={isActive}
    draggable="true"
    onclick={navigate}
    oncontextmenu={openMenu}
    onkeydown={(e) => { if (e.key === 'Enter') navigate(); }}
    {ondragstart}
    {ondragend}
    role="button"
    tabindex="0"
    title={conversation.title}
  >
    <span class="conv-pin" class:visible={conversation.pinned}>📌</span>
    <span class="conv-title">{truncateTitle(conversation.title)}</span>
    {#if conversation.forked_from_id}
      <span class="conv-fork-icon" title="Forked conversation">⎇</span>
    {/if}
    <button
      class="conv-action-btn"
      onclick={(e) => { e.stopPropagation(); startRename(); }}
      aria-label="Rename conversation"
      title="Rename conversation"
    >✏</button>
    <button
      class="conv-action-btn danger"
      onclick={(e) => { e.stopPropagation(); void conversationsStore.remove(conversation.id); }}
      aria-label="Delete conversation"
      title="Delete conversation"
    >🗑</button>
    <button class="conv-menu-btn" onclick={(e) => { e.stopPropagation(); openMenu(e); }} aria-label="More options">⋯</button>
  </div>
{/if}

{#if menuOpen}
  <ContextMenu items={menuItems} x={menuX} y={menuY} onclose={() => menuOpen = false} />
{/if}

<style>
  .conv-item {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 13px;
    text-align: left;
    transition: background 0.1s, color 0.1s;
    min-width: 0;
  }
  .conv-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .conv-item.active { background: var(--accent-subtle); color: var(--text-primary); }

  .conv-pin { font-size: 10px; opacity: 0; flex-shrink: 0; }
  .conv-pin.visible { opacity: 1; }
  .conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv-fork-icon { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
  .conv-action-btn {
    padding: 2px 3px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    line-height: 1;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
  }
  .conv-action-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .conv-action-btn.danger { color: var(--danger); }
  .conv-action-btn.danger:hover { color: var(--danger); }
  .conv-menu-btn {
    opacity: 0;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--text-muted);
    transition: opacity 0.1s, background 0.1s;
    background: transparent;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
  }
  .conv-item:hover .conv-menu-btn { opacity: 1; }
  .conv-menu-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }

  .rename-input {
    width: 100%;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--accent);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
</style>
