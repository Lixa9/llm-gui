import { Hono } from 'hono';
import { requireAuth } from './auth';
import { getConfig } from './config';
import { logger } from './logger';
import type { ModelYamlEntry } from './types';

export const modelsRouter = new Hono();
modelsRouter.use('*', requireAuth);

interface OpenAIModel {
  id: string;
}

let _cache: { models: ModelYamlEntry[]; at: number } | null = null;
const CACHE_TTL = 60_000;

export function invalidateModelCache() {
  _cache = null;
}

function parseModels(data: unknown): OpenAIModel[] | null {
  if (Array.isArray(data)) return data as OpenAIModel[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.data)) return d.data as OpenAIModel[];
    if (Array.isArray(d.models)) return d.models as OpenAIModel[];
  }
  return null;
}

export async function fetchModels(userRole: string): Promise<ModelYamlEntry[]> {
  const cfg = getConfig();

  if (!_cache || Date.now() - _cache.at > CACHE_TTL) {
    if (!cfg.openai.base_url) {
      _cache = { models: cfg.models ?? [], at: Date.now() };
    } else {
      try {
        const res = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/models`, {
          headers: cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const raw = await res.json();
          const list = parseModels(raw);
          if (list) {
            const yamlModels = cfg.models ?? [];
            const yamlById = new Map(yamlModels.map(m => [m.id, m]));
            const merged: ModelYamlEntry[] = list.map((m: OpenAIModel) => yamlById.get(m.id) ?? {
              id: m.id,
              display_name: m.id,
              allowed_roles: ['admin'],
            });
            _cache = { models: merged, at: Date.now() };
          } else {
            logger.warn('Unexpected /models response format', { url: cfg.openai.base_url });
            _cache = { models: _cache?.models ?? cfg.models ?? [], at: Date.now() };
          }
        } else {
          logger.warn('Failed to fetch models from inference engine', {
            url: cfg.openai.base_url,
            status: res.status,
          });
          _cache = { models: _cache?.models ?? cfg.models ?? [], at: Date.now() };
        }
      } catch (e) {
        logger.error('Error fetching models from inference engine', {
          url: cfg.openai.base_url,
          error: (e as Error).message,
        });
        _cache = { models: _cache?.models ?? cfg.models ?? [], at: Date.now() };
      }
    }
  }

  const cache = _cache;
  return cache.models.filter(m => m.allowed_roles.includes(userRole as 'admin' | 'user'));
}

export async function findAllowedModel(modelId: string, userRole: string): Promise<ModelYamlEntry | undefined> {
  return (await fetchModels(userRole)).find(model => model.id === modelId);
}

modelsRouter.get('/', async (c) => {
  const user = c.get('user');
  const models = await fetchModels(user.role);
  return c.json(models);
});
