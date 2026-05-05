<script lang="ts">
  import AdminUsers from './AdminUsers.svelte';
  import AdminPrompts from './AdminPrompts.svelte';
  import AdminAutomations from './AdminAutomations.svelte';
  import AdminConfig from './AdminConfig.svelte';

  type Tab = 'users' | 'prompts' | 'automations' | 'config';
  let activeTab = $state<Tab>('users');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'users', label: 'Users' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'automations', label: 'Automations' },
    { id: 'config', label: 'Config' },
  ];
</script>

<div class="admin-view">
  <div class="admin-header">
    <h2 class="admin-title">Admin</h2>
    <div class="tab-bar">
      {#each tabs as tab}
        <button class="tab-btn" class:active={activeTab === tab.id} onclick={() => activeTab = tab.id}>
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="admin-body">
    {#if activeTab === 'users'}
      <AdminUsers />
    {:else if activeTab === 'prompts'}
      <AdminPrompts />
    {:else if activeTab === 'automations'}
      <AdminAutomations />
    {:else if activeTab === 'config'}
      <AdminConfig />
    {/if}
  </div>
</div>

<style>
  .admin-view { display: flex; flex-direction: column; height: 100%; }
  .admin-header {
    padding: 20px 24px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .admin-title { font-size: 20px; font-weight: 600; }

  .tab-bar { display: flex; gap: 2px; }
  .tab-btn {
    padding: 7px 14px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    margin-bottom: -1px;
    transition: color 0.1s, border-color 0.1s;
  }
  .tab-btn:hover { color: var(--text-primary); }
  .tab-btn.active { color: var(--text-primary); border-bottom-color: var(--accent); }

  .admin-body { flex: 1; overflow: auto; padding: 20px 24px; }
</style>
