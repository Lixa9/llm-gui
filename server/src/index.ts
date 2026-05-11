import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { getCookie } from 'hono/cookie';
import { loadConfig, reloadConfig, getConfig } from './config';
import { openDatabase } from './db/index';
import { reconcileYaml } from './reconcile';
import { authRouter, requireAuth } from './auth';
import { relayRouter } from './relay';
import { conversationsRouter, foldersRouter } from './conversations';
import { modelsRouter } from './models';
import { promptsRouter } from './prompts';
import { presetsRouter } from './presets';
import { preferencesRouter } from './preferences';
import { automationsRouter, initScheduler } from './automations';
import { adminRouter } from './admin';
import { uploadsRouter } from './uploads';
import { logger } from './logger';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const STATIC_DIR = process.env.STATIC_DIR ?? './static';

// Startup checks
const KNOWN_WEAK_SECRETS = new Set([
  'change-me-to-a-random-32-char-string',
  'changeme',
  'secret',
  'mysecret',
  'supersecret',
  'password',
]);

if (!process.env.SECRET_KEY?.trim()) {
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  process.env.SECRET_KEY = generated;
  process.stderr.write(
    'WARNING: SECRET_KEY not set — using ephemeral generated key. Sessions will not persist across restarts.\n' +
    `  Set SECRET_KEY=${generated} in your environment to make sessions persistent.\n`
  );
} else if (
  process.env.SECRET_KEY.length < 32 ||
  KNOWN_WEAK_SECRETS.has(process.env.SECRET_KEY.trim().toLowerCase())
) {
  process.stderr.write(
    'FATAL: SECRET_KEY is too short or a known default. Set it to a random string of at least 32 characters.\n'
  );
  process.exit(1);
}

// Load config
let config: ReturnType<typeof getConfig>;
try {
  config = loadConfig();
  logger.info('Config loaded');
} catch (e) {
  process.stderr.write(`FATAL: Config load failed: ${String(e)}\n`);
  process.exit(1);
}

// Open database
const db = openDatabase(config.database.path);
logger.info('Database opened', { path: config.database.path });

// Reconcile YAML
reconcileYaml();

// Build Hono app
const app = new Hono();

// Request logger middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info('request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  });
});

// CORS: same-origin only — localhost allowed on any port for dev convenience
const LOCALHOST_ORIGIN = /^https?:\/\/localhost(:\d+)?$/;

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin) {
    const cfg = getConfig();
    if (origin !== cfg.app.base_url && !LOCALHOST_ORIGIN.test(origin)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }
  return next();
});

// Routes
app.route('/api/auth', authRouter);
app.route('/api/chat', relayRouter);
app.route('/api/conversations', conversationsRouter);
app.route('/api/folders', foldersRouter);
app.route('/api/models', modelsRouter);
app.route('/api/prompts', promptsRouter);
app.route('/api/presets', presetsRouter);
app.route('/api/preferences', preferencesRouter);
app.route('/api/automations', automationsRouter);
app.route('/api/admin', adminRouter);
app.route('/api/uploads', uploadsRouter);

// Health check — minimal response; does not probe internal services
app.get('/health', (c) => c.json({ status: 'ok' }));

// SPA fallback — serve index.html for all non-API routes
app.use('*', serveStatic({ root: STATIC_DIR }));
app.get('*', async (c) => {
  return Bun.file(`${STATIC_DIR}/index.html`).exists()
    ? c.html(await Bun.file(`${STATIC_DIR}/index.html`).text())
    : c.text('Not found', 404);
});

// Init scheduler
initScheduler();

// Periodic backend connectivity warning
const BACKEND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function startBackendHealthCheck() {
  if (!getConfig().litellm.base_url) return;
  setInterval(async () => {
    const cfg = getConfig();
    if (!cfg.litellm.base_url) return;
    try {
      const res = await fetch(`${cfg.litellm.base_url}/models`, {
        headers: cfg.litellm.api_key ? { Authorization: `Bearer ${cfg.litellm.api_key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn('backend unreachable', { url: cfg.litellm.base_url, status: res.status });
      }
    } catch (e) {
      logger.warn('backend unreachable', { url: cfg.litellm.base_url, error: (e as Error).message });
    }
  }, BACKEND_CHECK_INTERVAL_MS);
}

startBackendHealthCheck();

// Hot-reload config on SIGHUP
process.on('SIGHUP', reloadConfig);

// Start server
const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info(`Server started on port ${PORT}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
