import { api } from '$lib/api';
import { toast } from '../components/ui/Toast.svelte';
import type { UserPreferences } from '$lib/types';

function parseCollapsedFolderIds(value: string | undefined): string[] {
  try {
    const ids: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function createPreferencesStore() {
  let prefs = $state<UserPreferences>({
    sound_enabled: 'true',
    sound_volume: '0.6',
    default_model_id: '',
    default_preset_id: '',
    theme: '',
    collapsed_folder_ids: '[]',
  });

  let systemTheme = $state<'dark' | 'light'>('dark');

  if (typeof window !== 'undefined' && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    systemTheme = media.matches ? 'light' : 'dark';

    const handler = (e: MediaQueryListEvent) => {
      systemTheme = e.matches ? 'light' : 'dark';
    };

    try {
      media.addEventListener('change', handler);
    } catch {
      // Fallback for older browsers
      (media as any).addListener(handler);
    }
  }

  const soundEnabled = $derived(prefs.sound_enabled === 'true');
  const soundVolume = $derived(parseFloat(prefs.sound_volume ?? '0.6'));
  const defaultModelId = $derived(prefs.default_model_id ?? '');
  const defaultPresetId = $derived(prefs.default_preset_id ?? '');
  const theme = $derived(prefs.theme === 'dark' || prefs.theme === 'light' ? prefs.theme : systemTheme);

  const collapsedFolderIds = $derived(parseCollapsedFolderIds(prefs.collapsed_folder_ids));
  let writeQueue=Promise.resolve();
  function setFolderOpen(id: string, open: boolean) {
    const ids = collapsedFolderIds.filter(value => value !== id);
    if (!open) ids.push(id);
    void set('collapsed_folder_ids', JSON.stringify(ids));
  }

  async function load() {
    try {
      prefs = await api.preferences.get();
    } catch {
      // use defaults
    }
  }

  async function set(key: string, value: string) {
    const prev = prefs;
    prefs = { ...prefs, [key]: value };
    try {
      const write=writeQueue.catch(()=>{}).then(()=>api.preferences.set(key,value));
      writeQueue=write;await write;
    } catch (e) {
      if(prefs[key]===value)prefs={...prefs,[key]:prev[key]};
      toast((e as Error).message, 'error');
    }
  }

  return {
    get soundEnabled() { return soundEnabled; },
    get soundVolume() { return soundVolume; },
    get defaultModelId() { return defaultModelId; },
    get defaultPresetId() { return defaultPresetId; },
    get theme() { return theme; },
    get collapsedFolderIds(){return collapsedFolderIds;},
    load, set, setFolderOpen,
  };
}

export const preferencesStore = createPreferencesStore();
