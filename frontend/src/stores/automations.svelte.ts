import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import type { Automation, AutomationRun } from '$lib/types';

function createAutomationsStore() {
  let automations = $state<Automation[]>([]);
  let runsByAutomation = $state<Record<string, AutomationRun[]>>({});

  async function load() {
    automations = await api.automations.list();
  }

  const crud = makeCrud(api.automations, () => automations, (v) => { automations = v; });

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
    load, ...crud, trigger, loadRuns,
  };
}

export const automationsStore = createAutomationsStore();
