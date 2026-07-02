import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { dirname } from 'path';
import { applySchema } from './schema';
import { logger } from '../logger';

// Thin wrapper over node:sqlite that matches the better-sqlite3 call-site interface.
// node:sqlite's StatementSync returns Record<string, SQLOutputValue> from .all()/.get(),
// which TypeScript won't let you directly cast to domain row types. Wrapping the
// return as unknown restores the ergonomics of better-sqlite3.
class Stmt {
  constructor(private s: StatementSync) {}

  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.s.run(...(params as Parameters<StatementSync['run']>));
  }

  get(...params: unknown[]): unknown {
    return this.s.get(...(params as Parameters<StatementSync['get']>));
  }

  all(...params: unknown[]): unknown[] {
    return this.s.all(...(params as Parameters<StatementSync['all']>)) as unknown[];
  }
}

export class Db {
  private inner: DatabaseSync;
  private stmtCache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): Stmt {
    let s = this.stmtCache.get(sql);
    if (!s) { s = this.inner.prepare(sql); this.stmtCache.set(sql, s); }
    return new Stmt(s);
  }

  close(): void {
    this.stmtCache.clear();
    this.inner.close();
  }
}

let _db: Db | null = null;

export function openDatabase(path: string): Db {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Db(path);
  applySchema(db);

  try { chmodSync(path, 0o600); } catch { /* ignore on systems without chmod */ }

  _db = db;
  return db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('Database closed cleanly');
  }
}

export function getDb(): Db {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function safeParseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function sqliteBool(v: number | boolean | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return v === 1 || v === true;
}

export function runTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN TRANSACTION');
  try {
    const res = fn();
    db.exec('COMMIT');
    return res;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function initDatabaseSecret(db: Db): { secretKey: string; cleanup: () => void } {
  const instanceId = crypto.randomUUID();
  const heartbeatThreshold = 30000; // 30 seconds
  const heartbeatInterval = 10000; // 10 seconds
  const heartbeatExpiry = 60000; // 60 seconds

  // Clean up any stale heartbeats first to avoid false active count
  try {
    db.prepare('DELETE FROM active_instances WHERE last_heartbeat < ?').run(Date.now() - heartbeatExpiry);
  } catch (e) {
    logger.error('Failed to clean up stale heartbeats', { error: String(e) });
  }

  // Check if there are other active instances
  let hasActiveInstances = false;
  try {
    const activeRow = db.prepare('SELECT COUNT(*) as count FROM active_instances WHERE last_heartbeat > ?').get(Date.now() - heartbeatThreshold) as { count: number } | undefined;
    hasActiveInstances = !!(activeRow && activeRow.count > 0);
  } catch (e) {
    logger.error('Failed to query active instances', { error: String(e) });
  }

  let secretKey = '';

  if (hasActiveInstances) {
    // Other instances are running, read existing secret key
    try {
      const secretRow = db.prepare("SELECT value FROM system_secrets WHERE key = 'session_secret'").get() as { value: string } | undefined;
      if (secretRow?.value) {
        secretKey = secretRow.value;
        logger.info('Using existing database-backed secret key (active instances detected)');
      }
    } catch (e) {
      logger.error('Failed to retrieve secret key from db', { error: String(e) });
    }
  }

  if (!secretKey) {
    // No active instances or key not found in db, generate a new one
    secretKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    try {
      db.prepare("INSERT OR REPLACE INTO system_secrets (key, value) VALUES ('session_secret', ?)").run(secretKey);
      logger.info('Generated new database-backed secret key');
    } catch (e) {
      logger.error('Failed to save generated secret key to db', { error: String(e) });
    }
  }

  // Register this instance
  try {
    db.prepare('INSERT INTO active_instances (id, last_heartbeat) VALUES (?, ?)').run(instanceId, Date.now());
  } catch (e) {
    logger.error('Failed to register instance in active_instances', { error: String(e) });
  }

  // Set up heartbeat timer
  const timer = setInterval(() => {
    try {
      db.prepare('INSERT OR REPLACE INTO active_instances (id, last_heartbeat) VALUES (?, ?)').run(instanceId, Date.now());
      db.prepare('DELETE FROM active_instances WHERE last_heartbeat < ?').run(Date.now() - heartbeatExpiry);
    } catch (e) {
      logger.error('Failed to update instance heartbeat', { error: String(e) });
    }
  }, heartbeatInterval);
  timer.unref();

  // Cleanup function to be called on graceful shutdown
  const cleanup = () => {
    clearInterval(timer);
    try {
      db.prepare('DELETE FROM active_instances WHERE id = ?').run(instanceId);
      logger.info('Deregistered instance from active_instances');
    } catch (e) {
      logger.error('Failed to deregister instance from active_instances', { error: String(e) });
    }
  };

  return { secretKey, cleanup };
}
