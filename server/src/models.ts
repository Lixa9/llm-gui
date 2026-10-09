import { Hono } from 'hono';
import { requireAuth } from './auth.ts';
import { getConfig } from './config.ts';
import { logger } from './logger.ts';
import type { ModelYamlEntry } from './types.ts';

export const modelsRouter = new Hono();
modelsRouter.use('*', requireAuth);

interface OpenAIModel {
  id: string;
}

let _cache: { models: ModelYamlEntry[]; at: number } | null = null;
const CACHE_TTL = 60_000;
let revision = 0;
let refresh: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

export function invalidateModelCache() {
  _cache = null;
  revision++;
  refresh = null;
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

async function refreshModels(): Promise<void> {
  if (refresh) return refresh;
  const cfg = getConfig();
  const currentRevision = revision;
  const previous = _cache;
  const task = (async () => {
    let models = previous?.models ?? cfg.models ?? [];
    if (cfg.openai.base_url) {
      try {
        const res = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/models`, {
          headers: cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const list = parseModels(await res.json());
          if (list) {
            const yamlById = new Map((cfg.models ?? []).map(model => [model.id, model]));
            models = list.map(model => yamlById.get(model.id) ?? {
              id: model.id, display_name: model.id, allowed_roles: ['admin'],
            });
          } else logger.warn('Unexpected /models response format', { url: cfg.openai.base_url });
        } else {
          await res.body?.cancel();
          logger.warn('Failed to fetch models from inference engine', { url: cfg.openai.base_url, status: res.status });
        }
      } catch (error) {
        logger.error('Error fetching models from inference engine', { url: cfg.openai.base_url, error: (error as Error).message });
      }
    }
    if (revision === currentRevision && getConfig() === cfg) _cache = { models, at: Date.now() };
  })();
  refresh = task;
  try { await task; }
  finally { if (refresh === task) refresh = null; }
}

export async function fetchModels(userRole: string): Promise<ModelYamlEntry[]> {
  while (!_cache || Date.now() - _cache.at > CACHE_TTL) {
    await refreshModels();
  }
  return _cache.models.filter(model => model.allowed_roles.includes(userRole as 'admin' | 'user'));
}

export function startModelRefresh(): void {
  if (refreshTimer) return;
  const tick = () => {
    if (!_cache || Date.now() - _cache.at >= CACHE_TTL - 15_000) {
      void refreshModels().catch(error => logger.warn('Model refresh failed', { error: String(error) }));
    }
  };
  tick();
  refreshTimer = setInterval(tick, 5_000);
  refreshTimer.unref();
}

export function stopModelRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export async function findAllowedModel(modelId: string, userRole: string): Promise<ModelYamlEntry | undefined> {
  return (await fetchModels(userRole)).find(model => model.id === modelId);
}

modelsRouter.get('/', async (c) => {
  const user = c.get('user');
  const models = await fetchModels(user.role);
  return c.json(models);
});
