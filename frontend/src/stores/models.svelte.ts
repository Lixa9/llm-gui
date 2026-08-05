import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import { loadResource } from '$lib/loadResource';
import type { ModelInfo, ModelPreset } from '$lib/types';

function createModelsStore() {
  let models = $state<ModelInfo[]>([]);
  let presets = $state<ModelPreset[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    await loadResource(
      () => Promise.all([api.models.list(), api.presets.list()]),
      ([m, p]) => { models = m; presets = p; },
      (value) => { loading = value; },
      (value) => { error = value; },
    );
  }

  const presetCrud = makeCrud(api.presets, () => presets, (v) => { presets = v; });

  return {
    get models() { return models; },
    get presets() { return presets; },
    get loading() { return loading; },
    get error() { return error; },
    load,
    createPreset: presetCrud.create,
    updatePreset: presetCrud.update,
    deletePreset: presetCrud.remove,
  };
}

export const modelsStore = createModelsStore();
