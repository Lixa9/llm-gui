import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { readFile } from 'fs/promises';
import { loadConfig, reloadConfig, getConfig } from './config';
import { openDatabase, closeDatabase } from './db/index';
import { reconcileYaml } from './reconcile';
import { authRouter, purgeExpiredSessions, isLocalAuthEnabled } from './auth';
import { relayRouter } from './relay';
import { conversationsRouter } from './conversations';
import { foldersRouter } from './folders';
import { modelsRouter } from './models';
import { promptsRouter } from './prompts';
import { presetsRouter } from './presets';
import { preferencesRouter } from './preferences';
import { automationsRouter } from './automations';
import { initScheduler, stopScheduler } from './automation-scheduler';
import { adminRouter } from './admin';
import { purgeOrphanUploads, uploadsRouter } from './uploads';
import { logger } from './logger';
import { sweepBuckets } from './ratelimit';
import { waitForBackgroundTasks } from './lifecycle';

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
await openDatabase();
logger.info('PostgreSQL database opened');

// Reconcile YAML
await reconcileYaml();

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

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_API_BODY_LIMIT = 2 * 1024 * 1024;
const LARGE_API_BODY_LIMIT = 60 * 1024 * 1024;
const defaultBodyLimit = bodyLimit({ maxSize: DEFAULT_API_BODY_LIMIT, onError: c => c.json({ error: 'Request body too large' }, 413) });
const largeBodyLimit = bodyLimit({ maxSize: LARGE_API_BODY_LIMIT, onError: c => c.json({ error: 'Request body too large' }, 413) });

app.use('/api/*', async (c, next) => {
  // Hono's bodyLimit checks Content-Length when reliable and otherwise reads
  // the body stream with a hard cap before replaying the bounded body.
  const isLargeBodyRoute = c.req.path === '/api/chat' || c.req.path === '/api/uploads';
  return (isLargeBodyRoute ? largeBodyLimit : defaultBodyLimit)(c, next);
});

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin) {
    const cfg = getConfig();
    const allowDevOrigin = process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin);
    if (origin !== cfg.app.base_url && !allowDevOrigin) {
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
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (getConfig().app.base_url.startsWith('https://')) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
await initScheduler();

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
const purgeInterval = setInterval(() => { purgeExpiredSessions().catch(error => logger.warn('Session purge failed', { error: String(error) })); }, 60 * 60 * 1000);

// Sweep rate limit buckets every 5 minutes
void sweepBuckets();
const sweepInterval = setInterval(() => { void sweepBuckets(); }, 5 * 60 * 1000);

// Remove uploads abandoned before they were attached to a message.
void purgeOrphanUploads().catch(error => logger.warn('Upload orphan purge failed', { error: String(error) }));
const orphanUploadInterval = setInterval(() => {
  void purgeOrphanUploads().catch(error => logger.warn('Upload orphan purge failed', { error: String(error) }));
}, 60 * 60 * 1000);

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

async function handleShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections, but keep the database open until active
  // HTTP streams and tracked background jobs have finished.
  let httpClosed = false;
  const httpClosedPromise = new Promise<void>(resolve => {
    server.close((err) => {
      httpClosed = true;
      if (err) logger.error('Error closing HTTP server', { error: String(err) });
      else logger.info('HTTP server closed');
      resolve();
    });
  });
  let forceCloseTimer: NodeJS.Timeout;
  const forceClosePromise = new Promise<void>(resolve => {
    forceCloseTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timeout reached. Force closing connections...');
      const s = server as any;
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      resolve();
    }, 10000);
  });
  await Promise.race([
    httpClosedPromise,
    forceClosePromise,
  ]);
  clearTimeout(forceCloseTimer!);
  if (!httpClosed) await Promise.race([httpClosedPromise, new Promise(resolve => setTimeout(resolve, 2000))]);

  // Clean up intervals and schedulers
  if (backendCheckInterval) clearInterval(backendCheckInterval);
  clearInterval(purgeInterval);
  clearInterval(sweepInterval);
  clearInterval(orphanUploadInterval);
  stopScheduler();

  await waitForBackgroundTasks(10_000);

  try {
    await closeDatabase();
  } catch (e) {
    logger.error('Error closing database', { error: String(e) });
  }

  // Allow the node process to exit naturally, or force exit if still hanging after 12 seconds
  setTimeout(() => {
    logger.warn('Forcing process exit after shutdown sequence completion');
    process.exit(0);
  }, 12000).unref();
}

process.on('SIGTERM', () => { void handleShutdown('SIGTERM'); });
process.on('SIGINT', () => { void handleShutdown('SIGINT'); });
