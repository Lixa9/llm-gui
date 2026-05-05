import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import type { SystemPrompt } from '$lib/types';

function createPromptsStore() {
  let prompts = $state<SystemPrompt[]>([]);

  const personal = $derived(prompts.filter(p => p.owner_sub !== null && !p.deleted_at));
  const system = $derived(prompts.filter(p => p.owner_sub === null && !p.deleted_at));

  async function load() {
    prompts = await api.prompts.list();
  }

  const crud = makeCrud(api.prompts, () => prompts, (v) => { prompts = v; });

  return {
    get prompts() { return prompts; },
    get personal() { return personal; },
    get system() { return system; },
    load, ...crud,
  };
}

export const promptsStore = createPromptsStore();
