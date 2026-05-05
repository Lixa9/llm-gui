import { api } from '$lib/api';
import type { ModelInfo, ModelPreset } from '$lib/types';

function createModelsStore() {
  let models = $state<ModelInfo[]>([]);
  let presets = $state<ModelPreset[]>([]);

  async function load() {
    const [m, p] = await Promise.all([api.models.list(), api.presets.list()]);
    models = m;
    presets = p;
  }

  async function createPreset(data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) {
    const p = await api.presets.create(data);
    presets = [...presets, p];
    return p;
  }

  async function updatePreset(id: string, data: Partial<Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>>) {
    const p = await api.presets.update(id, data);
    presets = presets.map(x => x.id === id ? p : x);
    return p;
  }

  async function deletePreset(id: string) {
    await api.presets.delete(id);
    presets = presets.filter(p => p.id !== id);
  }

  return {
    get models() { return models; },
    get presets() { return presets; },
    load, createPreset, updatePreset, deletePreset,
  };
}

export const modelsStore = createModelsStore();
