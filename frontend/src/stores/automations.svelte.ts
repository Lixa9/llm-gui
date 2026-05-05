import { api } from '$lib/api';
import type { Automation, AutomationRun } from '$lib/types';

function createAutomationsStore() {
  let automations = $state<Automation[]>([]);
  let runsByAutomation = $state<Record<string, AutomationRun[]>>({});

  async function load() {
    automations = await api.automations.list();
  }

  async function create(data: Pick<Automation, 'name' | 'type' | 'definition'>) {
    const a = await api.automations.create(data);
    automations = [...automations, a];
    return a;
  }

  async function update(id: string, data: Partial<Pick<Automation, 'name' | 'definition' | 'enabled'>>) {
    const a = await api.automations.update(id, data);
    automations = automations.map(x => x.id === id ? a : x);
    return a;
  }

  async function remove(id: string) {
    await api.automations.delete(id);
    automations = automations.filter(a => a.id !== id);
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
    load, create, update, remove, trigger, loadRuns,
  };
}

export const automationsStore = createAutomationsStore();
