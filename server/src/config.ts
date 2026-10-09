import { readFileSync, accessSync, constants, writeFileSync, mkdirSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { scheduledDefinitionSchema } from './automation-definition.ts';
import { DEFAULT_AUTO_TITLE_PROMPT } from './title-request.ts';
import { logger } from './logger.ts';

const CONFIG_DIR = process.env.CONFIG_DIR ?? '/app/config';

export const CONFIG_FILES = ['config.yaml', 'models.yaml', 'prompts.yaml', 'presets.yaml', 'automations.yaml'];

const roleSchema = z.enum(['admin', 'user']);

const STORAGE_UNIT_FACTORS: Record<string, number> = {
  B: 1,
  K: 1024,
  KB: 1024,
  KIB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
  TIB: 1024 ** 4,
};

export function parseStorageSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.exec(value.trim());
  if (!match) throw new Error('Storage quota must look like 10G, 512M, or 0');
  const bytes = Number(match[1]) * (STORAGE_UNIT_FACTORS[(match[2] ?? 'B').toUpperCase()] ?? 1);
  if (!Number.isSafeInteger(bytes)) throw new Error('Storage quota is too large');
  return bytes;
}

const storageSizeSchema = z.string()
  .trim()
  .regex(/^\d+(?:\.\d+)?\s*(?:B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i, 'Storage quota must look like "10G", "512M", or "0"')
  .transform(parseStorageSize);

const configSchema = z.object({
  app: z.object({
    name: z.string().trim().min(1).max(80).default('Chat'),
    tagline: z.string().max(200).default(''),
    logo_url: z.string().regex(/^\/(?!\/)[a-zA-Z0-9_./-]+$/).optional(),
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    base_url: z.string().default('http://localhost:3000'),
  }),
  openai: z.object({
    base_url: z.string().default(''),
    api_key: z.string().optional(),
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
    requests_per_minute: z.number().int().min(0).default(60),
    requests_per_hour: z.number().int().min(0).default(300),
    concurrent_streams: z.number().int().min(0).default(2),
    global_workers: z.number().int().min(1).max(100).default(8),
    workers_per_owner: z.number().int().min(1).max(20).default(2),
    max_queued_jobs: z.number().int().min(1).max(10000).default(200),
  }).default({}),
  attachments: z.object({
    max_request_bytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(32 * 1024 * 1024),
    max_images: z.number().int().min(0).max(1000).default(100),
    max_files: z.number().int().min(1).max(200).default(50),
    max_text_chars: z.number().int().min(1000).max(10000000).default(500000),
    processing_workers: z.number().int().min(1).max(8).default(2),
  }).default({}),
  storage: z.object({
    quota: storageSizeSchema,
  }).strict().default({ quota: '0' }),
  conversation: z.object({
    max_output_bytes: z.number().int().min(1024).max(10000000).default(1000000),
    max_frame_bytes: z.number().int().min(1024).max(10000000).default(1000000),
    auto_title: z.boolean().default(false),
    auto_title_model: z.string().trim().min(1).max(300).optional(),
    auto_title_prompt: z.string().trim().min(1).max(10000).default(DEFAULT_AUTO_TITLE_PROMPT),
    generation_max_duration_ms: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(30 * 60 * 1000),
    generation_idle_timeout_ms: z.number().int().min(1_000).max(60 * 60 * 1000).default(2 * 60 * 1000),
    generation_max_attempts: z.number().int().min(1).max(20).default(3),
  }).superRefine((conversation, context) => {
    if (conversation.auto_title && !conversation.auto_title_model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auto_title_model'],
        message: 'conversation.auto_title_model is required when conversation.auto_title is true. Configure an upstream model explicitly or disable auto-title.',
      });
    }
  }).default({}),
});

const roles = z.array(roleSchema).min(1).default(['admin', 'user']);
const modelSchema = z.object({
  id: z.string().trim().min(1).max(300), display_name: z.string().min(1).max(200), allowed_roles: roles,
  history_mode: z.literal('full', {errorMap: () => ({message: 'history_mode: latest_only is no longer supported. Remove history_mode; every backend receives full history.'})}).optional(),
  capabilities: z.object({
    vision: z.boolean().default(false), native_pdf: z.boolean().default(false),
    image_detail: z.enum(['auto', 'low', 'high']).default('auto'),
    stream_usage: z.boolean().default(false),
    max_text_chars: z.number().int().min(1000).optional(),
  }).default({}),
}).refine(model=>!model.capabilities.native_pdf || model.capabilities.vision,{message:'Native PDF models must enable vision'})
  .transform(({history_mode: _historyMode, ...model}) => model);
const promptSchema = z.object({ name: z.string().min(1).max(200), content: z.string().max(100000), allowed_roles: roles });
const presetSchema = z.object({ name: z.string().min(1).max(200), base_model_id: z.string().min(1), system_prompt: z.string().max(100000).optional(), allowed_roles: roles });
const automationSchema = scheduledDefinitionSchema.extend({ name: z.string().min(1).max(200), allowed_roles: roles });

export type AppConfig = z.output<typeof configSchema> & {
  models: z.output<typeof modelSchema>[];
  prompts: z.output<typeof promptSchema>[];
  presets: z.output<typeof presetSchema>[];
  automations: z.output<typeof automationSchema>[];
};

function uniqueEntries<T extends Record<string, unknown>>(entries: T[], key: keyof T, label: string): T[] {
  if (new Set(entries.map(e => e[key])).size !== entries.length) throw new Error(`Duplicate ${key.toString()} in ${label}`);
  return entries;
}

export function configurationRevision(config=getConfig()):string {
  // A new request contract must also fence replicas running the previous code.
  return createHash('sha256').update('conversation-transport-v2\0').update(JSON.stringify(config)).digest('hex');
}
export async function runtimeConfigurationIsCurrent():Promise<boolean>{
  const {getDb}=await import('./db/index.ts');
  const row=await getDb().prepare("SELECT revision FROM runtime_configuration WHERE key='active'").get<{revision:string}>();
  return !row || row.revision===activeRevision;
}
/** All replicas watch the same configuration mount. A shared activation revision
 * fences requests/work on stale replicas until their next successful reload. */
let refreshInProgress: Promise<void> | null = null;
export async function refreshChangedConfiguration(dependencies: ReloadConfigDependencies = {}):Promise<void>{
  if (refreshInProgress) return refreshInProgress;
  const task = (async () => {
    try {
      const source = await readConfigurationSource();
      if (source !== activeSource) {
        const candidate = readConfig(source);
        if (configurationRevision(candidate) !== configurationRevision()) await reloadConfig(dependencies);
        else activeSource = source;
      }
    } catch (error) {
      logger.warn('Configuration refresh failed; retaining current configuration', { error: String(error) });
    }
  })();
  refreshInProgress = task;
  try { await task; }
  finally { if (refreshInProgress === task) refreshInProgress = null; }
}

/** Credentials never enter durable request snapshots. A changed account/key fails closed. */
export function providerIdentity(config = getConfig()): { base_url: string; revision: string } {
  return { base_url: config.openai.base_url.replace(/\/$/, ''), revision: createHash('sha256').update(JSON.stringify(config.openai)).digest('hex') };
}
export function assertProviderIdentity(identity?: { base_url: string; revision: string }): void {
  if(!identity)throw new Error('Legacy job has no provider identity. Resubmit this request.');
  if (identity && identity.revision !== providerIdentity().revision) throw new Error('Provider configuration changed. Resubmit this request to use the new provider.');
}

const DEFAULT_CONFIGS: Record<string, string> = {
  'config.yaml': [
    'app:',
    '  name: "Chat"',
    '  base_url: "http://localhost:3000"',
    '',
    'openai:',
    '  base_url: "${OPENAI_BASE_URL}"',
    '  api_key: "${OPENAI_API_KEY}"',
    '',
    'storage:',
    '  # Per-user upload quota; use values such as "10G". 0 means unlimited.',
    '  quota: "0"',
    '',
    'conversation:',
    '  auto_title: false',
    '  # Set an upstream model ID before enabling automatic titles.',
    '  # auto_title_model: "your-title-model-id"',
    `  auto_title_prompt: ${JSON.stringify(DEFAULT_AUTO_TITLE_PROMPT)}`,
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

let _config: AppConfig | null = null;
let reloadQueue: Promise<void> = Promise.resolve();
let activeSource = '';
let loadedSource = '';
let activeRevision = '';

async function readConfigurationSource(): Promise<string> {
  const files = await Promise.all(CONFIG_FILES.map(async name => {
    try { return await readFile(join(CONFIG_DIR, name), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }));
  return JSON.stringify([files, process.env]);
}

function readConfig(source?: string): AppConfig {
  if (source === undefined) {
    scaffoldConfigIfNeeded();
    const files = CONFIG_FILES.map(name => {
      try { return readFileSync(join(CONFIG_DIR, name), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    });
    source = JSON.stringify([files, process.env]);
  }
  loadedSource = source;
  const [files] = JSON.parse(source) as [string[]];
  const yaml = (name: string) => expandEnv(parseYaml(files[CONFIG_FILES.indexOf(name)]) ?? {});
  const parsed = configSchema.parse(yaml('config.yaml'));
  const models = z.object({models:z.array(modelSchema).default([])}).strict().parse(yaml('models.yaml')).models;
  const prompts = z.object({prompts:z.array(promptSchema).default([])}).strict().parse(yaml('prompts.yaml')).prompts;
  const presets = z.object({presets:z.array(presetSchema).default([])}).strict().parse(yaml('presets.yaml')).presets;
  const automations = z.object({automations:z.array(automationSchema).default([])}).strict().parse(yaml('automations.yaml')).automations;
  const candidate = {
    ...parsed,
    models: uniqueEntries(models, 'id', 'models'),
    prompts: uniqueEntries(prompts, 'name', 'prompts'),
    presets: uniqueEntries(presets, 'name', 'presets'),
    automations: uniqueEntries(automations, 'name', 'automations'),
  };
  if (candidate.models.length) {
    const known = new Map(candidate.models.map(model => [model.id, model]));
    if (candidate.conversation.auto_title && !known.has(candidate.conversation.auto_title_model!)) {
      throw new Error(`conversation.auto_title_model references an unconfigured model: ${candidate.conversation.auto_title_model}`);
    }
    for (const entry of [...candidate.presets.map(preset => ({ name:preset.name, model:preset.base_model_id, roles:preset.allowed_roles })), ...candidate.automations.map(automation => ({ name:automation.name, model:automation.model, roles:automation.allowed_roles }))]) {
      const model = known.get(entry.model);
      if (!model) throw new Error(`${entry.name} references an unconfigured model: ${entry.model}`);
      if (entry.roles.some(role => !model.allowed_roles.includes(role))) throw new Error(`${entry.name} allows roles without access to ${entry.model}`);
    }
  }
  return candidate;
}

export function loadConfig(): AppConfig {
  const config = readConfig();
  _config = config;
  activeSource = loadedSource;
  activeRevision = configurationRevision(config);
  return config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded');
  return _config;
}

export interface ReloadConfigDependencies {
  reconcile?: (config: AppConfig) => Promise<void>;
  invalidateCaches?: () => Promise<void>;
}

async function invalidateConfigCaches(): Promise<void> {
  const [models, auth] = await Promise.all([import('./models.ts'), import('./auth.ts')]);
  models.invalidateModelCache();
  auth.invalidateAuthDiscoveryCache();
}

async function performReload(dependencies: ReloadConfigDependencies): Promise<boolean> {
  logger.info('Reloading config (SIGHUP)');
  try {
    const source = await readConfigurationSource();
    const candidate = readConfig(source);
    const reconcile = dependencies.reconcile ?? (async (config: AppConfig) => {
      const module = await import('./reconcile.ts');
      await module.reconcileYaml(config);
    });
    await reconcile(candidate);
    _config = candidate;
    activeSource = source;
    activeRevision = configurationRevision(candidate);
    try {
      await (dependencies.invalidateCaches ?? invalidateConfigCaches)();
    } catch (error) {
      logger.warn('Configuration reloaded but cache invalidation failed', { error: String(error) });
    }
    logger.info('Config reload complete');
    return true;
  } catch (error) {
    logger.error('Config reload failed; keeping previous configuration', { error: String(error) });
    return false;
  }
}

export function reloadConfig(dependencies: ReloadConfigDependencies = {}): Promise<boolean> {
  const result = reloadQueue.then(() => performReload(dependencies));
  reloadQueue = result.then(() => undefined, () => undefined);
  return result;
}
