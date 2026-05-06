import { api } from '$lib/api';
import type { Conversation, ConversationFolder } from '$lib/types';

function createConversationsStore() {
  let list = $state<Conversation[]>([]);
  let folders = $state<ConversationFolder[]>([]);
  let activeId = $state<string | null>(null);
  let searchResults = $state<Conversation[]>([]);
  let searching = $state(false);
  let activeFolderId = $state<string | null>(null);
  let draggingConvId = $state<string | null>(null);

  const sorted = $derived(
    [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const at = a.last_message_at ?? a.created_at;
      const bt = b.last_message_at ?? b.created_at;
      return bt - at;
    }),
  );

  async function load() {
    const [convs, fols] = await Promise.all([api.conversations.list(), api.folders.list()]);
    list = convs;
    folders = fols;
  }

  async function create(opts: Parameters<typeof api.conversations.create>[0] = {}): Promise<Conversation> {
    const conv = await api.conversations.create(opts);
    list = [conv, ...list];
    return conv;
  }

  async function update(id: string, data: Parameters<typeof api.conversations.update>[1]) {
    const updated = await api.conversations.update(id, data);
    list = list.map(c => c.id === id ? updated : c);
    return updated;
  }

  async function rename(id: string, title: string) {
    return update(id, { title });
  }

  async function pin(id: string, pinned: boolean) {
    return update(id, { pinned });
  }

  async function move(id: string, folder_id: string | null) {
    return update(id, { folder_id });
  }

  async function remove(id: string) {
    await api.conversations.delete(id);
    list = list.filter(c => c.id !== id);
    if (activeId === id) {
      activeId = null;
      window.location.hash = '#/chat';
    }
  }

  async function removeAll() {
    await api.conversations.deleteAll();
    list = [];
    activeId = null;
    window.location.hash = '#/chat';
  }

  async function duplicate(id: string) {
    const copy = await api.conversations.duplicate(id);
    list = [copy, ...list];
    return copy;
  }

  async function fork(id: string, messageId: string) {
    const forked = await api.conversations.fork(id, messageId);
    list = [forked, ...list];
    return forked;
  }

  async function search(q: string) {
    if (!q.trim()) { searchResults = []; return; }
    searching = true;
    try {
      searchResults = await api.conversations.search(q);
    } finally {
      searching = false;
    }
  }

  function updateTitle(id: string, title: string) {
    list = list.map(c => c.id === id ? { ...c, title, title_auto: true } : c);
  }

  function setActive(id: string | null) {
    activeId = id;
  }

  function setActiveFolder(id: string | null) {
    activeFolderId = id;
  }

  function setDragging(id: string | null) {
    draggingConvId = id;
  }

  async function createFolder(name: string, parent_id?: string) {
    const folder = await api.folders.create({ name, parent_id });
    folders = [...folders, folder];
    return folder;
  }

  async function renameFolder(id: string, name: string) {
    const updated = await api.folders.update(id, { name });
    folders = folders.map(f => f.id === id ? updated : f);
  }

  async function deleteFolder(id: string) {
    await api.folders.delete(id);
    folders = folders.filter(f => f.id !== id);
    list = list.map(c => c.folder_id === id ? { ...c, folder_id: null } : c);
  }

  return {
    get list() { return list; },
    get sorted() { return sorted; },
    get folders() { return folders; },
    get activeId() { return activeId; },
    get activeFolderId() { return activeFolderId; },
    get draggingConvId() { return draggingConvId; },
    get searchResults() { return searchResults; },
    get searching() { return searching; },
    load, create, update, rename, pin, move,
    remove, removeAll, duplicate, fork, search, updateTitle, setActive, setActiveFolder, setDragging,
    createFolder, renameFolder, deleteFolder,
  };
}

export const conversationsStore = createConversationsStore();
