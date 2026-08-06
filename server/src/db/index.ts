import { Pool, types as pgTypes, type PoolClient, type QueryResultRow } from 'pg';
import { logger } from '../logger';

// Keep millisecond timestamps ergonomic for the existing API contracts.
pgTypes.setTypeParser(20, value => Number.parseInt(value, 10));

/**
 * Small PostgreSQL adapter.  Keeping this wrapper deliberately thin lets the
 * route modules use parameterized SQL without coupling them to a query builder.
 */
export class Db {
  constructor(private readonly pool: Pool) {}

  prepare(sql: string): Stmt {
    return new Stmt(this.pool, sql);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (client: TxDb) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TxDb(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withAdvisoryLock<T>(key: string, fn: (db: TxDb) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const result = await fn(new TxDb(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database pool closed cleanly');
  }
}

class QueryDb {
  constructor(protected readonly client: Pool | PoolClient) {}

  prepare(sql: string): Stmt {
    return new Stmt(this.client, sql);
  }
}

export class TxDb extends QueryDb {}

class Stmt {
  constructor(private readonly client: Pool | PoolClient, private readonly sql: string) {}

  async run(...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.client.query(this.convert(), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T | undefined> {
    const result = await this.client.query<T>(this.convert(), params);
    return result.rows[0];
  }

  async all<T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T[]> {
    const result = await this.client.query<T>(this.convert(), params);
    return result.rows;
  }

  private convert(): string {
    // Route modules use compact positional placeholders. Convert them once at
    // execution time while preserving all parameterization.
    let index = 0;
    return this.sql.replace(/\?/g, () => `$${++index}`);
  }
}

let _db: Db | null = null;

export async function openDatabase(connectionString = process.env.DATABASE_URL): Promise<Db> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_VERIFY !== 'false' } : undefined,
  });
  const db = new Db(pool);
  await applySchema(db);
  _db = db;
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

export function getDb(): Db {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function safeParseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function runTransaction<T>(fn: (db: TxDb) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

async function applySchema(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );

    CREATE TABLE IF NOT EXISTS users (
      sub TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      PRIMARY KEY (user_sub, key)
    );

    CREATE TABLE IF NOT EXISTS conversation_folders (
      id UUID PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      parent_id UUID REFERENCES conversation_folders(id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_folders_owner ON conversation_folders(owner_sub, name);

    CREATE TABLE IF NOT EXISTS system_prompts (
      id UUID PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      visible_to JSONB,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      deleted_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS model_presets (
      id UUID PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      base_model_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      visible_to JSONB,
      deleted_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New conversation',
      title_auto BOOLEAN NOT NULL DEFAULT false,
      model_id TEXT,
      preset_id UUID REFERENCES model_presets(id) ON DELETE SET NULL,
      system_prompt_id UUID REFERENCES system_prompts(id) ON DELETE SET NULL,
      custom_system_prompt TEXT,
      folder_id UUID REFERENCES conversation_folders(id) ON DELETE SET NULL,
      pinned BOOLEAN NOT NULL DEFAULT false,
      forked_from_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      forked_at_message_id UUID,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_sub, created_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL DEFAULT '[]',
      content_text TEXT NOT NULL DEFAULT '',
      model TEXT,
      status TEXT,
      timestamp BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      edited_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, timestamp, id);
    CREATE INDEX IF NOT EXISTS idx_msg_search ON messages USING GIN (to_tsvector('simple', content_text));

    CREATE TABLE IF NOT EXISTS automations (
      id UUID PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      definition JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      deleted_at BIGINT,
      visible_to JSONB,
      next_run_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS user_automation_subscriptions (
      user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (user_sub, automation_id)
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id UUID PRIMARY KEY,
      automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      started_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id UUID PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size BIGINT NOT NULL,
      extracted_text TEXT,
      file_meta JSONB,
      data BYTEA NOT NULL,
      derived_images JSONB,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_sub, created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      method TEXT NOT NULL CHECK (method IN ('oidc', 'local')),
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_lockouts (
      username TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      subject TEXT NOT NULL,
      bucket_start BIGINT NOT NULL,
      window_seconds INTEGER NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(subject, bucket_start, window_seconds)
    );

    CREATE TABLE IF NOT EXISTS stream_leases (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stream_leases_subject ON stream_leases(subject, expires_at);

    INSERT INTO schema_migrations(version) VALUES ('001_initial_postgres')
      ON CONFLICT(version) DO NOTHING;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '002_remove_token_usage') THEN
        ALTER TABLE messages DROP COLUMN IF EXISTS tokens_in;
        ALTER TABLE messages DROP COLUMN IF EXISTS tokens_out;
        INSERT INTO schema_migrations(version) VALUES ('002_remove_token_usage');
      END IF;
    END $$;
  `);
}
