import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import { loadResource } from '$lib/loadResource';
import type { Automation, AutomationRun } from '$lib/types';

function createAutomationsStore() {
  let automations = $state<Automation[]>([]);
  let runsByAutomation = $state<Record<string, AutomationRun[]>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    await loadResource(api.automations.list, (value) => { automations = value; }, (value) => { loading = value; }, (value) => { error = value; });
  }

  const crud = makeCrud(api.automations, () => automations, (v) => { automations = v; });

  async function toggleSubscription(id: string, enabled: boolean) {
    await api.automations.setSubscription(id, enabled);
    automations = automations.map(a => a.id === id ? { ...a, enabled } : a);
  }

  async function trigger(id: string) {
    const run = await api.automations.trigger(id);
    runsByAutomation = {
      ...runsByAutomation,
      [id]: [run, ...(runsByAutomation[id] ?? [])],
    };
    return run;
  }

  async function loadRuns(id: string) {
    const runs = await api.automations.runs(id);
    runsByAutomation = { ...runsByAutomation, [id]: runs };
  }

  return {
    get automations() { return automations; },
    get runsByAutomation() { return runsByAutomation; },
    get loading() { return loading; },
    get error() { return error; },
    load, ...crud, toggleSubscription, trigger, loadRuns,
  };
}

export const automationsStore = createAutomationsStore();
