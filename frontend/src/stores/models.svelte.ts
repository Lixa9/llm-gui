import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import type { ModelInfo, ModelPreset } from '$lib/types';

function createModelsStore() {
  let models = $state<ModelInfo[]>([]);
  let presets = $state<ModelPreset[]>([]);

  async function load() {
    const [m, p] = await Promise.all([api.models.list(), api.presets.list()]);
    models = m;
    presets = p;
  }

  const presetCrud = makeCrud(api.presets, () => presets, (v) => { presets = v; });

  return {
    get models() { return models; },
    get presets() { return presets; },
    load,
    createPreset: presetCrud.create,
    updatePreset: presetCrud.update,
    deletePreset: presetCrud.remove,
  };
}

export const modelsStore = createModelsStore();
