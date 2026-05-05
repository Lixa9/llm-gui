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
import { logger } from './logger';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const STATIC_DIR = process.env.STATIC_DIR ?? './static';

// Startup checks
if (!process.env.SECRET_KEY?.trim()) {
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  process.env.SECRET_KEY = generated;
  process.stderr.write(
    'WARNING: SECRET_KEY not set — using ephemeral generated key. Sessions will not persist across restarts.\n' +
    `  Set SECRET_KEY=${generated} in your environment to make sessions persistent.\n`
  );
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

// CORS: same-origin only
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin) {
    const cfg = getConfig();
    if (origin !== cfg.app.base_url && !origin.startsWith('http://localhost')) {
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

// Health check
app.get('/health', async (c) => {
  let litellmOk = false;
  try {
    const cfg = getConfig();
    const r = await fetch(`${cfg.litellm.base_url}/health`, { signal: AbortSignal.timeout(2000) });
    litellmOk = r.ok;
  } catch { /* ignore */ }

  return c.json({ status: 'ok', db: true, litellm: litellmOk });
});

// SPA fallback — serve index.html for all non-API routes
app.use('*', serveStatic({ root: STATIC_DIR }));
app.get('*', async (c) => {
  return Bun.file(`${STATIC_DIR}/index.html`).exists()
    ? c.html(await Bun.file(`${STATIC_DIR}/index.html`).text())
    : c.text('Not found', 404);
});

// Init scheduler
initScheduler();

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
