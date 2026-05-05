<script lang="ts">
  import { api } from '$lib/api';
  import type { ConfigFile } from '$lib/types';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import Modal from '../ui/Modal.svelte';
  import { toast } from '../ui/Toast.svelte';
  import { onMount } from 'svelte';

  let configs = $state<ConfigFile[]>([]);
  let loading = $state(true);
  let editingFile = $state<ConfigFile | null>(null);
  let editContent = $state('');
  let saving = $state(false);

  onMount(async () => {
    try { configs = await api.admin.config(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { loading = false; }
  });

  async function saveConfig() {
    if (!editingFile) return;
    saving = true;
    try {
      await api.admin.updateConfig(editingFile.name, editContent);
      configs = configs.map(c => c.name === editingFile!.name ? { ...c, content: editContent } : c);
      toast('Config saved', 'success');
      editingFile = null;
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      saving = false;
    }
  }
</script>

<div class="admin-config">
  {#if loading}
    <p class="loading">Loading…</p>
  {:else}
    <div class="config-files">
      {#each configs as cfg (cfg.name)}
        <div class="cfg-card">
          <div class="cfg-header">
            <span class="cfg-name">{cfg.name}</span>
            {#if cfg.writable}
              <Badge variant="success">writable</Badge>
            {:else}
              <Badge variant="muted">read-only mount</Badge>
            {/if}
            {#if cfg.writable}
              <Button variant="ghost" size="sm" onclick={() => { editingFile = cfg; editContent = cfg.content; }}>Edit</Button>
            {/if}
          </div>
          <pre class="cfg-content">{cfg.content}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Modal open={editingFile !== null} onclose={() => editingFile = null} title={`Edit ${editingFile?.name}`} width="640px">
  <textarea class="edit-ta" bind:value={editContent} rows={20}></textarea>
  <div class="modal-actions">
    <Button variant="ghost" onclick={() => editingFile = null}>Cancel</Button>
    <Button variant="primary" loading={saving} onclick={saveConfig}>Save</Button>
  </div>
</Modal>

<style>
  .loading { font-size: 13px; color: var(--text-muted); }
  .config-files { display: flex; flex-direction: column; gap: 12px; }
  .cfg-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .cfg-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .cfg-name { font-weight: 600; font-size: 13px; flex: 1; }
  .cfg-content {
    margin: 0;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    background: var(--code-bg);
    white-space: pre;
  }
  .edit-ta {
    width: 100%;
    resize: vertical;
    padding: 10px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
    outline: none;
    line-height: 1.5;
  }
  .edit-ta:focus { border-color: var(--accent); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
