<script lang="ts">
  import { conversationsStore } from '../../stores/conversations.svelte';
  import SidebarConversation from './SidebarConversation.svelte';
  import SidebarFolder from './SidebarFolder.svelte';
  import { debounce } from '$lib/utils';
  import { toast } from '../ui/Toast.svelte';

  let searchQuery = $state('');
  let collapsed = $state(false);
  let noFolderDragOver = $state(false);

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

  async function newFolder() {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    try {
      await conversationsStore.createFolder(name.trim());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  function onNoFolderDrop(e: DragEvent) {
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

<aside class="sidebar" class:collapsed>
  <div class="sidebar-header">
    <button class="new-chat-btn" onclick={newChat}>
      <span>+</span> New Chat
    </button>
    <button class="icon-btn" onclick={() => collapsed = !collapsed} title={collapsed ? 'Expand' : 'Collapse'}>
      {collapsed ? '»' : '«'}
    </button>
  </div>

  {#if !collapsed}
    <div class="sidebar-search">
      <input
        class="search-input"
        type="search"
        placeholder="Search conversations..."
        bind:value={searchQuery}
        oninput={handleSearchInput}
      />
    </div>

    <div class="sidebar-body">
      {#if conversationsStore.draggingConvId !== null}
        <div
          class="no-folder-drop"
          class:drag-over={noFolderDragOver}
          role="region"
          aria-label="Drop here to remove from folder"
          ondragover={(e) => { e.preventDefault(); noFolderDragOver = true; }}
          ondragleave={() => { noFolderDragOver = false; }}
          ondrop={onNoFolderDrop}
        >No folder</div>
      {/if}
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
        {#each unfolderedConvs as conv (conv.id)}
          <SidebarConversation conversation={conv} />
        {/each}
        {#if conversationsStore.sorted.length === 0}
          <div class="sidebar-hint">No conversations yet</div>
        {/if}
      {/if}
    </div>

    <div class="sidebar-footer">
      <button class="sidebar-footer-btn" onclick={newFolder} title="New folder">📁 New folder</button>
      <button class="sidebar-footer-btn danger" onclick={deleteAllChats} title="Delete all chats">🗑 Delete all chats</button>
    </div>
  {/if}
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
  .sidebar.collapsed { width: 40px; min-width: 40px; }

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

  .icon-btn {
    padding: 6px 7px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }

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
  }

  .no-folder-drop {
    padding: 5px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 11px;
    text-align: center;
    margin: 2px 0 4px;
    cursor: copy;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .no-folder-drop.drag-over {
    background: var(--accent-subtle);
    color: var(--accent);
    border-color: var(--accent);
  }

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
</style>
