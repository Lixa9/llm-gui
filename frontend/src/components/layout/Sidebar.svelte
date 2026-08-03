<script lang="ts">
  import { conversationsStore } from '../../stores/conversations.svelte';
  import SidebarConversation from './SidebarConversation.svelte';
  import SidebarFolder from './SidebarFolder.svelte';
  import { debounce } from '$lib/utils';
  import { toast } from '../ui/Toast.svelte';

  let searchQuery = $state('');
  let noFolderDragOver = $state(false);
  let creatingFolder = $state(false);
  let newFolderName = $state('');

  const rootFolders = $derived(conversationsStore.folders.filter(f => f.parent_id === null));
  const unfolderedConvs = $derived(conversationsStore.sorted.filter(c => c.folder_id === null));
  const isSearching = $derived(!!searchQuery.trim());

  const doSearch = debounce((q: string) => conversationsStore.search(q), 250);

  function handleSearchInput() {
    doSearch(searchQuery);
  }

  function newChat() {
    conversationsStore.setActive(null);
    window.location.hash = '#/chat';
  }

  function newFolder() {
    creatingFolder = true;
    newFolderName = '';
  }

  async function finishNewFolder() {
    const name = newFolderName.trim();
    if (!name) { creatingFolder = false; return; }
    try {
      await conversationsStore.createFolder(name);
      creatingFolder = false;
      newFolderName = '';
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  function isSpecificDropTarget(e: DragEvent): boolean {
    const target = e.target as HTMLElement | null;
    return !!target?.closest('.folder-header, .conv-item');
  }

  function onSidebarDragOver(e: DragEvent) {
    if (isSpecificDropTarget(e)) return;
    e.preventDefault();
    noFolderDragOver = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function onSidebarDragLeave(e: DragEvent) {
    if (e.target === e.currentTarget) noFolderDragOver = false;
  }

  function onNoFolderDrop(e: DragEvent) {
    if (isSpecificDropTarget(e)) return;
    e.preventDefault();
    noFolderDragOver = false;
    const convId = conversationsStore.draggingConvId;
    if (convId) conversationsStore.move(convId, null);
  }

  async function deleteAllChats() {
    const count = conversationsStore.list.length;
    if (!count) return;
    const ok = confirm(`Delete all ${count} conversation${count === 1 ? '' : 's'}? This cannot be undone.`);
    if (!ok) return;
    try {
      await conversationsStore.removeAll();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
</script>

<aside class="sidebar">
  <div class="sidebar-header">
    <button class="new-chat-btn" onclick={newChat}>
      <span>+</span> New Chat
    </button>
  </div>

  <div class="sidebar-search">
    <input
      class="search-input"
      type="search"
      placeholder="Search conversations..."
      bind:value={searchQuery}
      oninput={handleSearchInput}
    />
  </div>

  <div
    class="sidebar-body"
    class:no-folder-drag-over={noFolderDragOver}
    role="region"
    aria-label="Conversation list; drop on empty space to remove from folder"
    ondragover={onSidebarDragOver}
    ondragleave={onSidebarDragLeave}
    ondrop={onNoFolderDrop}
  >
    {#if isSearching}
      {#if conversationsStore.searching}
        <div class="sidebar-hint">Searching…</div>
      {:else if conversationsStore.searchResults.length === 0}
        <div class="sidebar-hint">No results</div>
      {:else}
        {#each conversationsStore.searchResults as conv (conv.id)}
          <SidebarConversation conversation={conv} />
        {/each}
      {/if}
    {:else}
      {#each rootFolders as folder (folder.id)}
        <SidebarFolder {folder} />
      {/each}
      <div class="unfiled-label">No folder</div>
      <div class="unfiled-list">
        {#each unfolderedConvs as conv (conv.id)}
          <SidebarConversation conversation={conv} />
        {/each}
      </div>
      {#if conversationsStore.sorted.length === 0}
        <div class="sidebar-hint">No conversations yet</div>
      {/if}
    {/if}
  </div>

  <div class="sidebar-footer">
    {#if creatingFolder}
      <form class="new-folder-form" onsubmit={(e) => { e.preventDefault(); finishNewFolder(); }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="new-folder-input" bind:value={newFolderName} placeholder="Folder name" autofocus onkeydown={(e) => { if (e.key === 'Escape') creatingFolder = false; }} />
      </form>
    {:else}
      <button class="sidebar-footer-btn" onclick={newFolder} title="New folder">📁 New folder</button>
    {/if}
    <button class="sidebar-footer-btn danger" onclick={deleteAllChats} title="Delete all chats">🗑 Delete all chats</button>
  </div>
</aside>

<style>
  .sidebar {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    overflow: hidden;
    transition: width 0.2s, min-width 0.2s;
    flex-shrink: 0;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 10px 8px;
    flex-shrink: 0;
  }

  .new-chat-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.1s;
  }
  .new-chat-btn:hover { background: var(--accent-hover); }

  .sidebar-search { padding: 0 10px 8px; }
  .search-input {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }

  .sidebar-body {
    flex: 1;
    overflow-y: auto;
    padding: 0 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    position: relative;
  }
  .sidebar-body.no-folder-drag-over {
    background: var(--accent-subtle);
  }

  .unfiled-label {
    padding: 8px 8px 3px;
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    pointer-events: none;
  }
  .unfiled-list { min-height: 28px; }

  .sidebar-hint { font-size: 12px; color: var(--text-muted); padding: 8px 8px; }

  .sidebar-footer {
    padding: 8px 10px;
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .sidebar-footer-btn {
    width: 100%;
    padding: 5px 8px;
    font-size: 12px;
    color: #c0c0c0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }
  .sidebar-footer-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .sidebar-footer-btn.danger { color: #f07070; }
  .sidebar-footer-btn.danger:hover { background: var(--bg-hover); color: #f07070; }
  .new-folder-form { padding: 0 0 4px; }
  .new-folder-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
  }
</style>
