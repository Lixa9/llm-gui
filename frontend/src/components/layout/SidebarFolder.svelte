<script lang="ts">
  import type { ConversationFolder } from '$lib/types';
  import SidebarConversation from './SidebarConversation.svelte';
  import SidebarFolder from './SidebarFolder.svelte';
  import { conversationsStore } from '../../stores/conversations.svelte';

  interface Props {
    folder: ConversationFolder;
  }
  let { folder }: Props = $props();

  let open = $state(true);
  let renaming = $state(false);
  let renameValue = $state('');
  let dragCounter = $state(0);
  let confirmingDelete = $state(false);

  const children = $derived(conversationsStore.folders.filter(f => f.parent_id === folder.id));
  const folderConvs = $derived(conversationsStore.sorted.filter(c => c.folder_id === folder.id));
  const isDragOver = $derived(dragCounter > 0);
  const isActiveFolder = $derived(conversationsStore.activeFolderId === folder.id);

  function toggleOpen() {
    open = !open;
    if (open) {
      conversationsStore.setActiveFolder(folder.id);
    } else {
      if (conversationsStore.activeFolderId === folder.id) {
        conversationsStore.setActiveFolder(null);
      }
    }
  }

  async function finishRename() {
    if (renameValue.trim()) await conversationsStore.renameFolder(folder.id, renameValue.trim());
    renaming = false;
  }

  function ondragover(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function ondragenter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
  }

  function ondragleave() {
    dragCounter--;
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    const convId = e.dataTransfer?.getData('text/plain');
    if (convId) {
      conversationsStore.move(convId, folder.id);
      open = true;
      conversationsStore.setActiveFolder(folder.id);
    }
  }

  function startRename() {
    renameValue = folder.name;
    confirmingDelete = false;
    renaming = true;
  }

  function deleteFolder() {
    if (!confirmingDelete) {
      confirmingDelete = true;
      return;
    }
    void conversationsStore.deleteFolder(folder.id);
  }
</script>

<div class="folder">
  {#if renaming}
    <form onsubmit={(e) => { e.preventDefault(); finishRename(); }}>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="rename-input" bind:value={renameValue} autofocus onblur={finishRename}
        onkeydown={(e) => { if (e.key === 'Escape') renaming = false; }} />
    </form>
  {:else}
    <div
      class="folder-header"
      class:drag-over={isDragOver}
      class:active-folder={isActiveFolder}
      onclick={toggleOpen}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleOpen(); }}
      {ondragover}
      {ondragenter}
      {ondragleave}
      {ondrop}
      role="button"
      tabindex="0"
    >
      <span class="folder-arrow">{open ? '▾' : '▸'}</span>
      <span class="folder-icon">📁</span>
      <span class="folder-name">{folder.name}</span>
      <button
        class="folder-action-btn"
        onclick={(e) => { e.stopPropagation(); startRename(); }}
        aria-label="Rename folder"
        title="Rename folder"
      >✏</button>
      <button
        class="folder-action-btn danger"
        class:confirming-delete={confirmingDelete}
        onclick={(e) => { e.stopPropagation(); deleteFolder(); }}
        aria-label={confirmingDelete ? 'Confirm delete folder' : 'Delete folder'}
        title={confirmingDelete ? 'Click again to delete folder' : 'Delete folder'}
      >🗑</button>
    </div>
  {/if}

  {#if open}
    <div class="folder-body">
      {#each children as child (child.id)}
        <SidebarFolder folder={child} />
      {/each}
      {#each folderConvs as conv (conv.id)}
        <SidebarConversation conversation={conv} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .folder { margin: 1px 0; }
  .folder-header {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    border-radius: var(--radius-sm);
    transition: background 0.1s, color 0.1s;
    text-align: left;
  }
  .folder-header:hover { background: var(--bg-hover); color: var(--text-primary); }
  .folder-header.active-folder { color: var(--accent); }
  .folder-header.drag-over {
    background: var(--accent-subtle);
    color: var(--accent);
    outline: 1px dashed var(--accent);
    outline-offset: -2px;
  }
  .folder-arrow { font-size: 9px; width: 10px; }
  .folder-icon { font-size: 12px; }
  .folder-name { flex: 1; font-weight: 500; letter-spacing: 0.02em; text-transform: uppercase; font-size: 11px; }
  .folder-action-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: var(--radius);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    flex-shrink: 0;
    line-height: 1;
  }
  .folder-action-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .folder-action-btn.danger { color: var(--danger); }
  .folder-action-btn.danger:hover { color: var(--danger); }
  .folder-action-btn.danger.confirming-delete,
  .folder-action-btn.danger.confirming-delete:hover {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: var(--radius);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--danger);
    color: var(--bg-surface);
  }

  .folder-body { padding-left: 12px; }

  .rename-input {
    width: 100%;
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
  }
</style>
