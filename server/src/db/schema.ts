import type { Database } from 'bun:sqlite';

export function applySchema(db: Database): void {
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  db.run('PRAGMA synchronous=NORMAL');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      sub TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role_override TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (user_sub, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
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

  db.run(`
    CREATE TABLE IF NOT EXISTS model_presets (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      base_model_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New conversation',
      title_auto INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      system_prompt_id TEXT REFERENCES system_prompts(id) ON DELETE SET NULL,
      custom_system_prompt TEXT,
      folder_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      forked_from_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      forked_at_message_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_sub, created_at DESC)`);

  db.run(`
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, timestamp)`);

  // FTS5 virtual table (external content mode)
  db.run(`
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
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
      INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
    END
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      owner_sub TEXT REFERENCES users(sub) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deleted_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT
    )
  `);
}
