import { api } from '$lib/api';
import type { UserPreferences } from '$lib/types';

function createPreferencesStore() {
  let prefs = $state<UserPreferences>({
    sound_enabled: 'true',
    sound_volume: '0.6',
    default_model_id: '',
    default_system_prompt: '',
  });

  const soundEnabled = $derived(prefs.sound_enabled !== 'false');
  const soundVolume = $derived(parseFloat(prefs.sound_volume ?? '0.6'));
  const defaultModelId = $derived(prefs.default_model_id ?? '');

  async function load() {
    try {
      prefs = await api.preferences.get();
    } catch {
      // use defaults
    }
  }

  async function set(key: string, value: string) {
    prefs = { ...prefs, [key]: value };
    try {
      await api.preferences.set(key, value);
    } catch {
      // optimistic update stays in memory even if server fails
    }
  }

  return {
    get prefs() { return prefs; },
    get soundEnabled() { return soundEnabled; },
    get soundVolume() { return soundVolume; },
    get defaultModelId() { return defaultModelId; },
    load, set,
  };
}

export const preferencesStore = createPreferencesStore();
