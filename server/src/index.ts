import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { readFile } from 'fs/promises';
import { loadConfig, reloadConfig, getConfig, updateConfigSecretKey } from './config';
import { openDatabase, initDatabaseSecret, closeDatabase } from './db/index';
import { reconcileYaml } from './reconcile';
import { authRouter, purgeExpiredSessions, isLocalAuthEnabled } from './auth';
import { relayRouter } from './relay';
import { conversationsRouter } from './conversations';
import { foldersRouter } from './folders';
import { modelsRouter } from './models';
import { promptsRouter } from './prompts';
import { presetsRouter } from './presets';
import { preferencesRouter } from './preferences';
import { automationsRouter, initScheduler, stopScheduler } from './automations';
import { adminRouter } from './admin';
import { uploadsRouter } from './uploads';
import { logger } from './logger';
import { sweepBuckets } from './ratelimit';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const STATIC_DIR = process.env.STATIC_DIR ?? './static';

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

// Initialize database-backed secret key
const { secretKey: dbSecret, cleanup: dbSecretCleanup } = initDatabaseSecret(db);
process.env.SECRET_KEY = dbSecret;
updateConfigSecretKey(dbSecret);

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

let isShuttingDown = false;

// Health check — minimal response; does not probe internal services
app.get('/health', (c) => {
  if (isShuttingDown) {
    return c.json({ status: 'shutting_down' }, 503);
  }
  return c.json({ status: 'ok' });
});

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
let backendCheckInterval: NodeJS.Timeout | null = null;

function startBackendHealthCheck() {
  if (!getConfig().openai.base_url) return;
  backendCheckInterval = setInterval(async () => {
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
const purgeInterval = setInterval(purgeExpiredSessions, 60 * 60 * 1000);

// Sweep rate limit buckets every 5 minutes
sweepBuckets();
const sweepInterval = setInterval(sweepBuckets, 5 * 60 * 1000);

// Hot-reload config on SIGHUP
process.on('SIGHUP', reloadConfig);

// Start server
const server = serve({
  port: PORT,
  fetch: app.fetch,
});

logger.info(`Server started on port ${PORT}`);

if (isLocalAuthEnabled()) {
  process.stderr.write(
    '\n\x1b[33m\x1b[1mWARNING: LOCAL_AUTH is active. This fallback configuration bypasses OIDC and should not be used in production.\x1b[22m\x1b[39m\n\n'
  );
}

// Graceful shutdown handling
let shutdownInProgress = false;

function handleShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      logger.error('Error closing HTTP server', { error: String(err) });
    } else {
      logger.info('HTTP server closed');
    }
  });

  // Force close remaining active connections after timeout
  const forceCloseTimeout = setTimeout(() => {
    logger.warn('Graceful shutdown timeout reached. Force closing connections...');
    const s = server as any;
    if (typeof s.closeAllConnections === 'function') {
      s.closeAllConnections();
    }
  }, 10000);
  forceCloseTimeout.unref();

  // Clean up intervals and schedulers
  if (backendCheckInterval) clearInterval(backendCheckInterval);
  clearInterval(purgeInterval);
  clearInterval(sweepInterval);
  stopScheduler();

  // Deregister db instance and close database
  try {
    dbSecretCleanup();
  } catch (e) {
    logger.error('Error during database secret cleanup', { error: String(e) });
  }

  try {
    closeDatabase();
  } catch (e) {
    logger.error('Error closing database', { error: String(e) });
  }

  // Allow the node process to exit naturally, or force exit if still hanging after 12 seconds
  setTimeout(() => {
    logger.warn('Forcing process exit after shutdown sequence completion');
    process.exit(0);
  }, 12000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
