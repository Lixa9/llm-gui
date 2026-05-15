import { readFileSync, accessSync, constants, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { AppConfig } from './types';
import { logger } from './logger';

const CONFIG_DIR = process.env.CONFIG_DIR ?? '/app/config';

const roleSchema = z.enum(['admin', 'user']);

const configSchema = z.object({
  app: z.object({
    name: z.string().default('Chat'),
    base_url: z.string().default('http://localhost:3000'),
    secret_key: z.string().min(1),
  }),
  litellm: z.object({
    base_url: z.string().default(''),
    api_key: z.string().optional(),
  }).default({}),
  database: z.object({
    path: z.string().default('/data/chat.db'),
  }).default({}),
  oidc: z.object({
    issuer: z.string(),
    client_id: z.string(),
    client_secret: z.string(),
    scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  }).optional(),
  rbac: z.object({
    group_claim: z.string().default('groups'),
    mappings: z.array(z.object({
      oidc_group: z.string(),
      role: roleSchema,
    })).default([]),
    default_role: roleSchema.default('user'),
  }).default({}),
  rate_limits: z.object({
    requests_per_minute: z.number().default(60),
    requests_per_hour: z.number().default(300),
    concurrent_streams: z.number().default(2),
  }).default({}),
  conversation: z.object({
    auto_title: z.boolean().default(true),
    auto_title_model: z.string().default('qwen3.5-0.8b'),
    context_window_tokens: z.number().default(100000),
    context_window_reserve: z.number().default(1000),
  }).default({}),
});

const DEFAULT_CONFIGS: Record<string, string> = {
  'config.yaml': [
    'app:',
    '  name: "Chat"',
    '  base_url: "http://localhost:3000"',
    '  secret_key: "${SECRET_KEY}"',
    '',
    'litellm:',
    '  base_url: "${LITELLM_BASE_URL}"',
    '  api_key: "${LITELLM_API_KEY}"',
    '',
    'database:',
    '  path: "/data/chat.db"',
    '',
  ].join('\n'),
  'models.yaml': 'models: []\n',
  'prompts.yaml': [
    'prompts:',
    '  - name: "Concise assistant"',
    '    content: "You are a helpful assistant. Keep responses short and to the point."',
    '    allowed_roles: [admin, user]',
    '',
    '  - name: "Code reviewer"',
    '    content: "You are an expert code reviewer. Focus on correctness, security, and clarity."',
    '    allowed_roles: [admin, user]',
    '',
  ].join('\n'),
  'presets.yaml': [
    'presets:',
    '  - name: "Code assistant"',
    '    base_model_id: "qwen3.5-0.8b"',
    '    system_prompt: "You are an expert software engineer. Write clean, idiomatic code and explain your reasoning."',
    '    allowed_roles: [admin, user]',
    '',
  ].join('\n'),
  'automations.yaml': [
    'automations:',
    '  - name: "Daily digest"',
    '    type: scheduled',
    '    interval: 1',
    '    unit: days',
    '    model: "qwen3.5-0.8b"',
    '    system_prompt: "You are a concise summarizer."',
    '    user_prompt: "Summarize the top tech news today in 5 bullet points."',
    '    allowed_roles: [admin]',
    '',
  ].join('\n'),
};

function scaffoldConfigIfNeeded(): void {
  // Ensure CONFIG_DIR exists
  mkdirSync(CONFIG_DIR, { recursive: true });

  // Check if CONFIG_DIR itself is writable
  let dirWritable = true;
  try { accessSync(CONFIG_DIR, constants.W_OK); }
  catch { dirWritable = false; }

  // Find which files are absent
  const missing: string[] = [];
  for (const name of CONFIG_FILES) {
    try { accessSync(join(CONFIG_DIR, name), constants.F_OK); }
    catch { missing.push(name); }
  }

  if (missing.length === 0) return;

  if (!dirWritable) {
    for (const name of missing) {
      logger.error('Config file missing and directory is read-only', { file: name, path: join(CONFIG_DIR, name) });
    }
    process.stderr.write(
      'FATAL: Missing config files in a read-only config directory. ' +
      'Mount the missing files or make the config directory writable.\n'
    );
    process.exit(1);
  }

  for (const name of missing) {
    const filePath = join(CONFIG_DIR, name);
    writeFileSync(filePath, DEFAULT_CONFIGS[name], 'utf8');
    logger.info('Created default config file', { file: name, path: filePath });
  }
}

function expandEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)]));
  }
  return obj;
}

function loadYaml(name: string): unknown {
  const path = join(CONFIG_DIR, name);
  try {
    const raw = readFileSync(path, 'utf8');
    return expandEnv(yaml.load(raw) as unknown ?? {});
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

function isWritable(name: string): boolean {
  const path = join(CONFIG_DIR, name);
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let _config: AppConfig | null = null;
const _writability: Record<string, boolean> = {};

export function loadConfig(): AppConfig {
  scaffoldConfigIfNeeded();
  const mainRaw = loadYaml('config.yaml') as Record<string, unknown>;
  const modelsRaw = loadYaml('models.yaml') as { models?: unknown[] };
  const promptsRaw = loadYaml('prompts.yaml') as { prompts?: unknown[] };
  const presetsRaw = loadYaml('presets.yaml') as { presets?: unknown[] };
  const automationsRaw = loadYaml('automations.yaml') as { automations?: unknown[] };

  const parsed = configSchema.parse(mainRaw);

  const config: AppConfig = {
    ...parsed,
    models: (modelsRaw.models ?? []) as AppConfig['models'],
    prompts: (promptsRaw.prompts ?? []) as AppConfig['prompts'],
    presets: (presetsRaw.presets ?? []) as AppConfig['presets'],
    automations: (automationsRaw.automations ?? []) as AppConfig['automations'],
  };

  // Probe writability
  for (const name of CONFIG_FILES) {
    _writability[name] = isWritable(name);
  }

  _config = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded');
  return _config;
}

export function reloadConfig(): void {
  logger.info('Reloading config (SIGHUP)');
  loadConfig();
  // Imported lazily to avoid circular dependency
  import('./models').then(m => m.invalidateModelCache());
}

export function isConfigWritable(name: string): boolean {
  return _writability[name] ?? false;
}

export function getConfigFileContent(name: string): string {
  const path = join(CONFIG_DIR, name);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function writeConfigFile(name: string, content: string): void {
  // Validate YAML syntax before touching the file on disk
  const parsed = yaml.load(content);
  // For the main config, also run schema validation so a bad write can't corrupt app state
  if (name === 'config.yaml') {
    configSchema.parse(expandEnv(parsed ?? {}));
  }
  const path = join(CONFIG_DIR, name);
  const tmp = join(dirname(path), `.${name}.tmp.${Date.now()}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  reloadConfig();
}

export const CONFIG_FILES = ['config.yaml', 'models.yaml', 'prompts.yaml', 'presets.yaml', 'automations.yaml'];
