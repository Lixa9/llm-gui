import type {
  User, Conversation, ConversationFolder, Message, SystemPrompt,
  ModelInfo, ModelPreset, Automation, AutomationRun,
  UserPreferences, AdminUser, ConfigFile, Role
} from './types';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json() as { error: string }).error ?? msg; } catch { /* ignore */ }
    throw new HttpError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => req<T>('GET', path);
const post = <T>(path: string, body?: unknown) => req<T>('POST', path, body);
const patch = <T>(path: string, body?: unknown) => req<T>('PATCH', path, body);
const del = <T>(path: string) => req<T>('DELETE', path);
const put = <T>(path: string, body?: unknown) => req<T>('PUT', path, body);

// Auth
export const api = {
  auth: {
    me: () => get<User>('/api/auth/me'),
    loginUrl: () => '/api/auth/login',
    logout: () => get<void>('/api/auth/logout'),
    localEnabled: () => get<{ enabled: boolean }>('/api/auth/local-enabled'),
    localLogin: (username: string, password: string) =>
      post<{ ok: boolean }>('/api/auth/local', { username, password }),
  },

  conversations: {
    list: () => get<Conversation[]>('/api/conversations'),
    create: (data: { model_id?: string; system_prompt_id?: string; custom_system_prompt?: string; folder_id?: string }) =>
      post<Conversation>('/api/conversations', data),
    get: (id: string) => get<Conversation>(`/api/conversations/${id}`),
    update: (id: string, data: Partial<Pick<Conversation, 'title' | 'folder_id' | 'pinned' | 'custom_system_prompt'>>) =>
      patch<Conversation>(`/api/conversations/${id}`, data),
    delete: (id: string) => del<void>(`/api/conversations/${id}`),
    deleteAll: () => del<void>('/api/conversations'),
    duplicate: (id: string) => post<Conversation>(`/api/conversations/${id}/duplicate`),
    fork: (id: string, messageId: string) =>
      post<Conversation>(`/api/conversations/${id}/fork`, { message_id: messageId }),
    search: (q: string) => get<Conversation[]>(`/api/conversations/search?q=${encodeURIComponent(q)}`),
    messages: (id: string) => get<Message[]>(`/api/conversations/${id}/messages`),
    editMessage: (convId: string, msgId: string, content: string) =>
      patch<Message>(`/api/conversations/${convId}/messages/${msgId}`, { content }),
    deleteMessage: (convId: string, msgId: string) =>
      del<void>(`/api/conversations/${convId}/messages/${msgId}`),
  },

  folders: {
    list: () => get<ConversationFolder[]>('/api/folders'),
    create: (data: { name: string; parent_id?: string }) => post<ConversationFolder>('/api/folders', data),
    update: (id: string, data: Partial<Pick<ConversationFolder, 'name' | 'parent_id'>>) =>
      patch<ConversationFolder>(`/api/folders/${id}`, data),
    delete: (id: string) => del<void>(`/api/folders/${id}`),
  },

  models: {
    list: () => get<ModelInfo[]>('/api/models'),
  },

  presets: {
    list: () => get<ModelPreset[]>('/api/presets'),
    create: (data: Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>) =>
      post<ModelPreset>('/api/presets', data),
    update: (id: string, data: Partial<Pick<ModelPreset, 'name' | 'base_model_id' | 'system_prompt'>>) =>
      patch<ModelPreset>(`/api/presets/${id}`, data),
    delete: (id: string) => del<void>(`/api/presets/${id}`),
  },

  prompts: {
    list: () => get<SystemPrompt[]>('/api/prompts'),
    create: (data: Pick<SystemPrompt, 'name' | 'content'>) => post<SystemPrompt>('/api/prompts', data),
    update: (id: string, data: Partial<Pick<SystemPrompt, 'name' | 'content'>>) =>
      patch<SystemPrompt>(`/api/prompts/${id}`, data),
    delete: (id: string) => del<void>(`/api/prompts/${id}`),
  },

  automations: {
    list: () => get<Automation[]>('/api/automations'),
    create: (data: Pick<Automation, 'name' | 'type' | 'definition'>) =>
      post<Automation>('/api/automations', data),
    update: (id: string, data: Partial<Pick<Automation, 'name' | 'definition' | 'enabled'>>) =>
      patch<Automation>(`/api/automations/${id}`, data),
    delete: (id: string) => del<void>(`/api/automations/${id}`),
    trigger: (id: string) => post<AutomationRun>(`/api/automations/${id}/trigger`),
    runs: (id: string) => get<AutomationRun[]>(`/api/automations/${id}/runs`),
  },

  uploads: {
    upload: async (file: File): Promise<{ url: string }> => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new HttpError(res.status, res.statusText);
      return res.json() as Promise<{ url: string }>;
    },
  },

  preferences: {
    get: () => get<UserPreferences>('/api/preferences'),
    set: (key: string, value: string) => put<void>(`/api/preferences/${key}`, { value }),
  },

  admin: {
    users: () => get<AdminUser[]>('/api/admin/users'),
    setRoleOverride: (sub: string, role: Role | null) =>
      patch<void>(`/api/admin/users/${sub}`, { role_override: role }),
    prompts: () => get<SystemPrompt[]>('/api/admin/prompts'),
    automations: () => get<Automation[]>('/api/admin/automations'),
    config: () => get<ConfigFile[]>('/api/admin/config'),
    updateConfig: (name: string, content: string) =>
      put<void>(`/api/admin/config/${name}`, { content }),
  },
};

export { HttpError };
