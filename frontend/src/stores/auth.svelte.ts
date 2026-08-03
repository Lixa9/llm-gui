import { api } from '$lib/api';
import type { User } from '$lib/types';

function createAuthStore() {
  let user = $state<User | null>(null);
  let loading = $state(true);
  let localAuthEnabled = $state(false);

  async function init() {
    loading = true;
    try {
      const [me, localStatus] = await Promise.allSettled([
        api.auth.me(),
        api.auth.localEnabled(),
      ]);
      user = me.status === 'fulfilled' ? me.value : null;
      localAuthEnabled = localStatus.status === 'fulfilled' ? localStatus.value.enabled : false;
    } finally {
      loading = false;
    }
  }

  async function localLogin(username: string, password: string): Promise<void> {
    await api.auth.localLogin(username, password);
    user = await api.auth.me();
  }

  async function logout() {
    await api.auth.logout().catch(() => {});
    window.location.href = '/';
  }

  return {
    get user() { return user; },
    get loading() { return loading; },
    get localAuthEnabled() { return localAuthEnabled; },
    init,
    localLogin,
    logout,
  };
}

export const authStore = createAuthStore();
