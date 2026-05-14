<script lang="ts">
  import { onMount } from 'svelte';
  import TopBar from './components/layout/TopBar.svelte';
  import Sidebar from './components/layout/Sidebar.svelte';
  import ChatView from './components/chat/ChatView.svelte';
  import PromptLibraryView from './components/prompts/PromptLibraryView.svelte';
  import PresetsView from './components/presets/PresetsView.svelte';
  import AutomationsView from './components/automations/AutomationsView.svelte';
  import AdminView from './components/admin/AdminView.svelte';
  import ToastContainer from './components/ui/ToastContainer.svelte';
  import Spinner from './components/ui/Spinner.svelte';
  import LoginView from './components/layout/LoginView.svelte';
  import { authStore } from './stores/auth.svelte';
  import { conversationsStore } from './stores/conversations.svelte';
  import { modelsStore } from './stores/models.svelte';
  import { promptsStore } from './stores/prompts.svelte';
  import { preferencesStore } from './stores/preferences.svelte';
  import { toast } from './components/ui/Toast.svelte';

  // Parse hash route
  let hash = $state(window.location.hash || '#/chat');

  function parseRoute(h: string): { view: string; id: string | null } {
    const path = h.replace(/^#/, '') || '/chat';
    const parts = path.split('/').filter(Boolean);
    const view = parts[0] ?? 'chat';
    const id = parts[1] ?? null;
    return { view, id };
  }

  const route = $derived(parseRoute(hash));

  function navigate(view: string) {
    window.location.hash = `#/${view}`;
  }

  onMount(() => {
    const onHashChange = () => { hash = window.location.hash; };
    window.addEventListener('hashchange', onHashChange);

    // Boot sequence — just resolve auth; store loading is driven by the $effect below
    authStore.init();

    // Sync active conversation from URL
    const syncActive = () => {
      const { view, id } = parseRoute(window.location.hash);
      if (view === 'chat' && id) {
        conversationsStore.setActive(id);
      }
    };
    window.addEventListener('hashchange', syncActive);
    syncActive();

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('hashchange', syncActive);
    };
  });

  // Load all stores once the user is authenticated (covers both initial load and post-login)
  $effect(() => {
    if (authStore.user) {
      conversationsStore.load().catch(e => toast(`Failed to load conversations: ${(e as Error).message}`, 'error'));
      modelsStore.load().catch(e => toast(`Failed to load models: ${(e as Error).message}`, 'error'));
      promptsStore.load().catch(e => toast(`Failed to load prompts: ${(e as Error).message}`, 'error'));
      preferencesStore.load();
    }
  });
</script>

{#if authStore.loading}
  <div class="loading-screen">
    <Spinner size={32} />
  </div>
{:else if !authStore.user}
  <LoginView />
{:else}
  <div class="app-shell">
    <TopBar currentView={route.view} onNavigate={navigate} />
    <div class="app-body">
      {#if route.view === 'chat'}
        <Sidebar />
        <main class="main-area">
          <ChatView conversationId={route.id} />
        </main>
      {:else if route.view === 'prompts'}
        <main class="main-area">
          <PromptLibraryView />
        </main>
      {:else if route.view === 'presets'}
        <main class="main-area">
          <PresetsView />
        </main>
      {:else if route.view === 'automations'}
        <main class="main-area">
          <AutomationsView />
        </main>
      {:else if route.view === 'admin' && authStore.user.role === 'admin'}
        <main class="main-area">
          <AdminView />
        </main>
      {:else}
        <main class="main-area">
          <ChatView conversationId={null} />
        </main>
      {/if}
    </div>
  </div>
{/if}

<ToastContainer />

<style>
  .loading-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .app-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .app-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .main-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
</style>
