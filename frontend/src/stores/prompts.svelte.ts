import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import { loadResource } from '$lib/loadResource';
import { sortByName } from '$lib/utils';
import type { SystemPrompt } from '$lib/types';

function createPromptsStore() {
  let prompts = $state<SystemPrompt[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const personal = $derived(sortByName(prompts.filter(p => p.owner_sub !== null && !p.deleted_at)));
  const system = $derived(sortByName(prompts.filter(p => p.owner_sub === null && !p.deleted_at)));

  async function load() {
    await loadResource(api.prompts.list, (value) => { prompts = value; }, (value) => { loading = value; }, (value) => { error = value; });
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
