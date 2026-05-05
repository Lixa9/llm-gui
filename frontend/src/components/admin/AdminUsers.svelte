<script lang="ts">
  import { api } from '$lib/api';
  import type { AdminUser, Role } from '$lib/types';
  import Badge from '../ui/Badge.svelte';
  import Select from '../ui/Select.svelte';
  import { toast } from '../ui/Toast.svelte';
  import { onMount } from 'svelte';

  let users = $state<AdminUser[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try { users = await api.admin.users(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { loading = false; }
  });

  const roleOptions = [
    { value: '', label: 'Default (from OIDC)' },
    { value: 'admin', label: 'Admin' },
    { value: 'user', label: 'User' },
  ];

  async function setOverride(sub: string, role: string) {
    try {
      await api.admin.setRoleOverride(sub, role as Role | null);
      users = users.map(u => u.sub === sub ? { ...u, role_override: role as Role | null } : u);
      toast('Role updated', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
</script>

<div class="admin-users">
  {#if loading}
    <p class="loading">Loading users…</p>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>User</th>
          <th>OIDC Role</th>
          <th>Override</th>
          <th>Effective Role</th>
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.sub)}
          <tr>
            <td>
              <div class="user-cell">
                <span class="user-name">{user.name}</span>
                <span class="user-email">{user.email}</span>
              </div>
            </td>
            <td>—</td>
            <td>
              <Select
                value={user.role_override ?? ''}
                options={roleOptions}
                onchange={(v) => setOverride(user.sub, v)}
              />
            </td>
            <td>
              <Badge variant={user.resolved_role === 'admin' ? 'danger' : 'accent'}>{user.resolved_role}</Badge>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .admin-users { overflow-x: auto; }
  .loading { color: var(--text-muted); font-size: 13px; }
  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border-subtle); }
  th { font-size: 11px; color: var(--text-muted); font-weight: 600; letter-spacing: 0.04em; }
  .user-cell { display: flex; flex-direction: column; gap: 2px; }
  .user-name { font-weight: 500; }
  .user-email { font-size: 12px; color: var(--text-muted); }
</style>
