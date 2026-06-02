<script lang="ts">
  import { authStore } from '../../stores/auth.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let submitting = $state(false);

  async function handleLocalLogin(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    submitting = true;
    try {
      await authStore.localLogin(username, password);
    } catch {
      error = 'Invalid username or password.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <div class="login-header">
      <div class="login-logo">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="36" height="36" rx="10" fill="var(--accent)"/>
          <path d="M10 18C10 13.58 13.58 10 18 10C22.42 10 26 13.58 26 18" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="18" cy="22" r="4" fill="white"/>
        </svg>
      </div>
      <h1 class="login-title">Sign in</h1>
    </div>

    <a class="btn-sso" href="/api/auth/login">
      <svg class="sso-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 2C5.58 2 2 5.58 2 10C2 14.42 5.58 18 10 18C14.42 18 18 14.42 18 10C18 5.58 14.42 2 10 2Z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M6 10H14M10 6L14 10L10 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Continue with SSO
    </a>

    {#if authStore.localAuthEnabled}
      <div class="divider"><span>or</span></div>

      <div class="local-warning-banner">
        <svg class="warning-icon" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
        </svg>
        <span><strong>Security Warning:</strong> Local fallback credentials are active. Bypasses OIDC.</span>
      </div>

      <form class="local-form" onsubmit={handleLocalLogin}>
        <div class="field">
          <label for="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            bind:value={username}
            autocomplete="username"
            placeholder="admin"
            disabled={submitting}
          />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            bind:value={password}
            autocomplete="current-password"
            placeholder="••••••••"
            disabled={submitting}
          />
        </div>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button class="btn-submit" type="submit" disabled={submitting || !username || !password}>
          {#if submitting}
            <Spinner size={16} />
          {:else}
            Sign in
          {/if}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .login-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }

  .login-card {
    width: 340px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .login-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }

  .login-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .btn-sso {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    transition: background 0.15s;
  }
  .btn-sso:hover { background: var(--accent-hover); }

  .sso-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .local-warning-banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(217, 119, 6, 0.15);
    border: 1px solid rgba(217, 119, 6, 0.3);
    border-radius: var(--radius-sm);
    color: #f59e0b;
    font-size: 11px;
    line-height: 1.4;
    animation: fadeIn 0.2s ease-out;
  }

  .warning-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .local-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .field input {
    padding: 8px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .field input:focus { border-color: var(--accent); }
  .field input:disabled { opacity: 0.5; }

  .error {
    font-size: 12px;
    color: var(--danger);
    margin: 0;
  }

  .btn-submit {
    padding: 9px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
  }
  .btn-submit:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent);
  }
  .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
