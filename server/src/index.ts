import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { readFile } from 'fs/promises';
import { loadConfig, reloadConfig, getConfig } from './config';
import { openDatabase } from './db/index';
import { reconcileYaml } from './reconcile';
import { authRouter, purgeExpiredSessions } from './auth';
import { relayRouter } from './relay';
import { conversationsRouter } from './conversations';
import { foldersRouter } from './folders';
import { modelsRouter } from './models';
import { promptsRouter } from './prompts';
import { presetsRouter } from './presets';
import { preferencesRouter } from './preferences';
import { automationsRouter, initScheduler } from './automations';
import { adminRouter } from './admin';
import { uploadsRouter } from './uploads';
import { logger } from './logger';
import { sweepBuckets } from './ratelimit';

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
try {
  loadConfig();
  logger.info('Config loaded');
} catch (e) {
  process.stderr.write(`FATAL: Config load failed: ${String(e)}\n`);
  process.exit(1);
}

// Open database
const db = openDatabase(getConfig().database.path);
logger.info('Database opened', { path: getConfig().database.path });

// Reconcile YAML
reconcileYaml();

// Build Hono app
const app = new Hono();

// Compression
app.use('*', compress());

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
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin) {
    const cfg = getConfig();
    if (origin !== cfg.app.base_url && !LOCALHOST_ORIGIN.test(origin)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  // Require a custom header on all state-mutating requests. Browsers cannot set
  // arbitrary headers on cross-origin requests without a preflight, so this
  // defends against CSRF from clients that omit the Origin header entirely.
  if (MUTATING_METHODS.has(c.req.method) && c.req.header('x-requested-with') !== 'llm-frontend') {
    return c.json({ error: 'Forbidden' }, 403);
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

// CSP for all non-API routes (API routes serve JSON, not HTML)
app.use('*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/')) {
    c.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'");
  }
});

// SPA fallback — serve index.html for all non-API routes
app.use('*', serveStatic({ root: STATIC_DIR }));
app.get('*', async (c) => {
  const indexPath = `${STATIC_DIR}/index.html`;
  try {
    const content = await readFile(indexPath, 'utf-8');
    return c.html(content);
  } catch {
    return c.text('Not found', 404);
  }
});

// Init scheduler
initScheduler();

// Periodic backend connectivity warning
const BACKEND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function startBackendHealthCheck() {
  if (!getConfig().openai.base_url) return;
  setInterval(async () => {
    const cfg = getConfig();
    if (!cfg.openai.base_url) return;
    try {
      const res = await fetch(`${cfg.openai.base_url}/models`, {
        headers: cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) {
        logger.warn('backend unreachable', { url: cfg.openai.base_url, status: res.status });
      }
    } catch (e) {
      logger.warn('backend unreachable', { url: cfg.openai.base_url, error: (e as Error).message });
    }
  }, BACKEND_CHECK_INTERVAL_MS);
}

startBackendHealthCheck();

// Purge expired sessions at startup and every hour
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000);

// Sweep rate limit buckets every 5 minutes
sweepBuckets();
setInterval(sweepBuckets, 5 * 60 * 1000);

// Hot-reload config on SIGHUP
process.on('SIGHUP', reloadConfig);

// Start server
const server = serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info(`Server started on port ${PORT}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
