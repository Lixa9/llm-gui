import { api } from '$lib/api';
import { makeCrud } from '$lib/crud';
import type { ModelInfo, ModelPreset } from '$lib/types';

function createModelsStore() {
  let models = $state<ModelInfo[]>([]);
  let presets = $state<ModelPreset[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      const [m, p] = await Promise.all([api.models.list(), api.presets.list()]);
      models = m;
      presets = p;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
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
