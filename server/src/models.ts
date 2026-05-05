import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getConfig } from './config';
import type { SessionPayload, ModelYamlEntry } from './types';

export const modelsRouter = new Hono();
modelsRouter.use('*', requireAuth);

interface LiteLLMModel {
  id: string;
}

let _cache: { models: ModelYamlEntry[]; at: number } | null = null;
const CACHE_TTL = 60_000;

export async function fetchModels(userRole: string): Promise<ModelYamlEntry[]> {
  const cfg = getConfig();

  if (!_cache || Date.now() - _cache.at > CACHE_TTL) {
    if (!cfg.litellm.base_url) {
      _cache = { models: cfg.models ?? [], at: Date.now() };
      return _cache.models.filter(m => m.allowed_roles.includes(userRole as 'admin' | 'user'));
    }
    try {
      const res = await fetch(`${cfg.litellm.base_url}/models`, {
        headers: cfg.litellm.api_key ? { Authorization: `Bearer ${cfg.litellm.api_key}` } : {},
      });
      if (res.ok) {
        const data = await res.json() as { data: LiteLLMModel[] };
        const yamlModels = cfg.models ?? [];
        const yamlById = new Map(yamlModels.map(m => [m.id, m]));

        const merged: ModelYamlEntry[] = data.data.map((m: LiteLLMModel) => {
          const override = yamlById.get(m.id);
          return override ?? {
            id: m.id,
            display_name: m.id,
            show_tool_calls: true,
            allowed_roles: ['admin'],
          };
        });

        _cache = { models: merged, at: Date.now() };
      } else {
        // Fall back to YAML-only
        if (!_cache) {
          _cache = { models: cfg.models ?? [], at: Date.now() };
        }
      }
    } catch {
      if (!_cache) {
        _cache = { models: cfg.models ?? [], at: Date.now() };
      }
    }
  }

  return _cache!.models.filter(m => m.allowed_roles.includes(userRole as 'admin' | 'user'));
}

modelsRouter.get('/', async (c) => {
  const user = c.get('user') as SessionPayload;
  const models = await fetchModels(user.role);
  return c.json(models);
});
