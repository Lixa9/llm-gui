import type { Db } from './index';

export function applySchema(db: Db): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      sub TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role_override TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (user_sub, key)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_prompts (
      id TEXT PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      visible_to TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deleted_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_presets (
      id TEXT PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      base_model_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      visible_to TEXT,
      deleted_at INTEGER
    )
  `);

  // Migration: add visible_to/deleted_at and relax owner_sub NOT NULL on existing databases
  {
    const cols = (db.prepare('PRAGMA table_info(model_presets)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('visible_to')) {
      db.exec(`
        CREATE TABLE model_presets_v2 (
          id TEXT PRIMARY KEY,
          owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
          name TEXT NOT NULL,
          base_model_id TEXT NOT NULL,
          system_prompt TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          visible_to TEXT,
          deleted_at INTEGER
        )
      `);
      db.exec(`INSERT INTO model_presets_v2 SELECT id, owner_sub, name, base_model_id, system_prompt, created_at, NULL, NULL FROM model_presets`);
      db.exec(`DROP TABLE model_presets`);
      db.exec(`ALTER TABLE model_presets_v2 RENAME TO model_presets`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New conversation',
      title_auto INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      preset_id TEXT REFERENCES model_presets(id) ON DELETE SET NULL,
      system_prompt_id TEXT REFERENCES system_prompts(id) ON DELETE SET NULL,
      custom_system_prompt TEXT,
      folder_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      forked_from_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      forked_at_message_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Migration for existing databases
  try { db.exec('ALTER TABLE conversations ADD COLUMN preset_id TEXT REFERENCES model_presets(id) ON DELETE SET NULL'); } catch { /* column already exists */ }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_sub, created_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '[]',
      content_text TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      tool_results TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      status TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      edited_at INTEGER
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, timestamp)`);

  // FTS5 virtual table (external content mode)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    )
  `);

  // We use rowid-based FTS. Since our messages table uses TEXT primary keys,
  // we need a way to map. SQLite assigns rowids automatically.
  // FTS will index content_text column.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deleted_at INTEGER,
      visible_to TEXT
    )
  `);
  try { db.exec('ALTER TABLE automations ADD COLUMN visible_to TEXT'); } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_automation_subscriptions (
      user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_sub, automation_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id        TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      sha256    TEXT NOT NULL,
      filename  TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size      INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_sub, created_at DESC)`);
  try { db.exec('ALTER TABLE uploads ADD COLUMN extracted_text TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE uploads ADD COLUMN file_meta TEXT'); } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS login_lockouts (
      username TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS active_instances (
      id TEXT PRIMARY KEY,
      last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}
