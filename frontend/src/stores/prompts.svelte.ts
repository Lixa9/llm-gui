import { api } from '$lib/api';
import type { SystemPrompt } from '$lib/types';

function createPromptsStore() {
  let prompts = $state<SystemPrompt[]>([]);

  const personal = $derived(prompts.filter(p => p.owner_sub !== null && !p.deleted_at));
  const system = $derived(prompts.filter(p => p.owner_sub === null && !p.deleted_at));

  async function load() {
    prompts = await api.prompts.list();
  }

  async function create(data: Pick<SystemPrompt, 'name' | 'content'>) {
    const p = await api.prompts.create(data);
    prompts = [...prompts, p];
    return p;
  }

  async function update(id: string, data: Partial<Pick<SystemPrompt, 'name' | 'content'>>) {
    const p = await api.prompts.update(id, data);
    prompts = prompts.map(x => x.id === id ? p : x);
    return p;
  }

  async function remove(id: string) {
    await api.prompts.delete(id);
    prompts = prompts.filter(p => p.id !== id);
  }

  return {
    get prompts() { return prompts; },
    get personal() { return personal; },
    get system() { return system; },
    load, create, update, remove,
  };
}

export const promptsStore = createPromptsStore();
