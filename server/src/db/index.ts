import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { dirname } from 'path';
import { applySchema } from './schema';

let _db: Database.Database | null = null;

export function openDatabase(path: string): Database.Database {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  applySchema(db);

  try { chmodSync(path, 0o600); } catch { /* ignore on systems without chmod */ }

  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function generateId(): string {
  return crypto.randomUUID();
}
