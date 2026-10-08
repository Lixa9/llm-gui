import { api } from '$lib/api';
import { authStore } from './auth.svelte';
import { toast } from '../components/ui/Toast.svelte';
import type { UploadResult } from '$lib/types';
export interface Draft {
  text: string;
  attachments: UploadResult[];
}
const cache = new Map<string, Draft>();
const saves = new Map<string, Promise<void>>();
function scoped(key: string) {
  return `${authStore.user?.sub ?? ''}:${key}`;
}
export const draftsStore = {
  async load(key: string): Promise<Draft> {
    const id = scoped(key),
      saved = cache.get(id);
    if (saved) return saved;
    const draft = await api.drafts.get(key);
    if (!cache.has(id)) cache.set(id, draft);
    return cache.get(id)!;
  },
  save(key: string, draft: Draft): Promise<void> {
    const id = scoped(key),
      owner = authStore.user?.sub;
    cache.set(id, draft);
    const task = (saves.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (authStore.user?.sub !== owner) throw new Error('Account changed before saving draft');
        return api.drafts.save(key, {
          text: draft.text,
          attachments: draft.attachments.map((a) => ({ id: a.id })),
        });
      });
    saves.set(id, task);
    void task.catch((error) => toast(`Draft could not be saved: ${(error as Error).message}`, 'error'));
    return task;
  },
};
