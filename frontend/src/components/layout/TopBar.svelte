<script lang="ts">
  import { authStore } from '../../stores/auth.svelte';
  import { preferencesStore } from '../../stores/preferences.svelte';

  interface Props {
    currentView: string;
    onNavigate: (view: string) => void;
  }
  let { currentView, onNavigate }: Props = $props();

  let userMenuOpen = $state(false);

  const navItems = [
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'prompts', label: 'Prompts', icon: '📝' },
    { id: 'presets', label: 'Presets', icon: '⚙' },
    { id: 'automations', label: 'Automations', icon: '🤖' },
  ];

  function navigate(view: string) {
    onNavigate(view);
    userMenuOpen = false;
  }

  function toggleTheme() {
    const nextTheme = preferencesStore.theme === 'dark' ? 'light' : 'dark';
    preferencesStore.set('theme', nextTheme);
  }

  function closeMenu(e: MouseEvent) {
    if (!(e.target as Element).closest('.user-menu-wrapper')) {
      userMenuOpen = false;
    }
  }
</script>

<svelte:window onclick={closeMenu} />

<header class="topbar">
  <div class="topbar-left">
    <span class="app-name">Chat</span>
    <nav class="nav">
      {#each navItems as item}
        <button
          class="nav-btn"
          class:active={currentView === item.id || (currentView.startsWith('chat') && item.id === 'chat')}
          onclick={() => navigate(item.id)}
        >
          {item.label}
        </button>
      {/each}
      {#if authStore.user?.role === 'admin'}
        <button
          class="nav-btn"
          class:active={currentView === 'admin'}
          onclick={() => navigate('admin')}
        >Admin</button>
      {/if}
    </nav>
  </div>

  <div class="topbar-right">
    <button class="theme-toggle-btn" onclick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
      {#if preferencesStore.theme === 'dark'}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
      {/if}
    </button>

    <div class="user-menu-wrapper">
      <button class="user-btn" onclick={(e) => { e.stopPropagation(); userMenuOpen = !userMenuOpen; }}>
        <span class="user-initial">
          {authStore.user?.name?.[0]?.toUpperCase() ?? authStore.user?.email?.[0]?.toUpperCase() ?? '?'}
        </span>
        <span class="user-name">{authStore.user?.name ?? authStore.user?.email}</span>
      </button>
      {#if userMenuOpen}
        <div class="user-menu">
          <div class="user-menu-info">
            <div class="user-menu-name">{authStore.user?.name}</div>
            <div class="user-menu-email">{authStore.user?.email}</div>
            <div class="user-menu-role">{authStore.user?.role}</div>
          </div>
          <hr class="user-menu-sep" />
          <button class="user-menu-item" onclick={() => authStore.logout()}>Sign out</button>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--topbar-height);
    padding: 0 16px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    z-index: 100;
  }

  .topbar-left { display: flex; align-items: center; gap: 20px; }
  .app-name { font-weight: 700; font-size: 15px; color: var(--text-primary); letter-spacing: -0.02em; }

  .nav { display: flex; gap: 2px; }
  .nav-btn {
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .nav-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav-btn.active { color: var(--text-primary); background: var(--bg-elevated); }

  .topbar-right { display: flex; align-items: center; }

  .theme-toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-right: 12px;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.15s, color 0.15s;
  }
  .theme-toggle-btn:hover {
    background-color: var(--bg-hover);
    color: var(--text-primary);
  }

  .user-menu-wrapper { position: relative; }
  .user-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-primary);
    transition: background 0.1s;
  }
  .user-btn:hover { background: var(--bg-hover); }

  .user-initial {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--accent-subtle);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .user-name { font-size: 13px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .user-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    min-width: 200px;
    padding: 4px;
    z-index: 200;
    animation: fadeDown 0.1s ease;
  }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-4px); } }

  .user-menu-info { padding: 10px 12px; }
  .user-menu-name { font-weight: 600; font-size: 13px; }
  .user-menu-email { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  .user-menu-role {
    font-size: 10px;
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-top: 4px;
  }
  .user-menu-sep { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
  .user-menu-item {
    display: block;
    width: 100%;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }
  .user-menu-item:hover { background: var(--bg-hover); }
</style>
