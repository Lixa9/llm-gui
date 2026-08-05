import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import type { SystemPrompt } from '$lib/types';

function createPromptsStore() {
  let prompts = $state<SystemPrompt[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const personal = $derived(prompts.filter(p => p.owner_sub !== null && !p.deleted_at).sort((a, b) => a.name.localeCompare(b.name)));
  const system = $derived(prompts.filter(p => p.owner_sub === null && !p.deleted_at).sort((a, b) => a.name.localeCompare(b.name)));

  async function load() {
    loading = true;
    error = null;
    try {
      prompts = await api.prompts.list();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  const crud = makeCrud(api.prompts, () => prompts, (v) => { prompts = v; });

  return {
    get prompts() { return prompts; },
    get personal() { return personal; },
    get system() { return system; },
    get loading() { return loading; },
    get error() { return error; },
    load, ...crud,
  };
}

export const promptsStore = createPromptsStore();
