import { api } from '$lib/api';
let branding = $state<{ name: string; tagline: string; logo_url?: string; accent_color?: string }>({
  name: 'Chat',
  tagline: '',
});
export const brandingStore = {
  get value() {
    return branding;
  },
  async load() {
    try {
      branding = await api.app.get();
    } catch {
      /* retain deployment defaults */
    }
  },
};
