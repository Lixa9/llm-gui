import { api } from '$lib/api';
import { authStore } from './auth.svelte';
import { toast } from '../components/ui/Toast.svelte';

let drafts = $state<Record<string, Record<string, string>>>({});
const loads = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<void>>();
const timers = new Map<string, { conversationId: string; flush: () => void; timer: ReturnType<typeof setTimeout> }>();

function scoped(conversationId: string) {
  return `${authStore.user?.sub ?? ''}:${conversationId}`;
}

function enqueue(key: string, owner: string | undefined, action: () => Promise<void>) {
  const task = (writes.get(key) ?? Promise.resolve()).then(() => {
    if (authStore.user?.sub !== owner) throw new Error('Account changed before saving draft');
    return action();
  }).catch(error => toast(`Message draft could not be saved: ${(error as Error).message}`, 'error'));
  writes.set(key, task);
  void task.then(() => { if (writes.get(key) === task) writes.delete(key); });
}

export const messageEditsStore = {
  load(conversationId: string): Promise<void> {
    const id = scoped(conversationId);
    if (drafts[id]) return Promise.resolve();
    const pending = loads.get(id);
    if (pending) return pending;
    const task = api.messageDrafts.list(conversationId).then(saved => {
      drafts[id] = { ...saved, ...drafts[id] };
    }).finally(() => loads.delete(id));
    loads.set(id, task);
    return task;
  },
  get(conversationId: string, messageId: string): string | undefined {
    return drafts[scoped(conversationId)]?.[messageId];
  },
  set(conversationId: string, messageId: string, text: string) {
    const id = scoped(conversationId), key = `${id}:${messageId}`;
    const owner = authStore.user?.sub;
    (drafts[id] ??= {})[messageId] = text;
    clearTimeout(timers.get(key)?.timer);
    const flush = () => {
      timers.delete(key);
      enqueue(key, owner, () => api.messageDrafts.save(conversationId, messageId, text));
    };
    timers.set(key, { conversationId, flush, timer: setTimeout(flush, 250) });
  },
  remove(conversationId: string, messageId: string) {
    const id = scoped(conversationId), key = `${id}:${messageId}`;
    clearTimeout(timers.get(key)?.timer);
    timers.delete(key);
    if (drafts[id]) delete drafts[id][messageId];
    // Queue deletion after any in-flight save so it cannot resurrect a draft.
    enqueue(key, authStore.user?.sub, () => api.messageDrafts.remove(conversationId, messageId));
  },
  flush(conversationId: string) {
    for (const pending of timers.values()) {
      if (pending.conversationId !== conversationId) continue;
      clearTimeout(pending.timer);
      pending.flush();
    }
  },
};
