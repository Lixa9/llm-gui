import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { dirname } from 'path';
import { applySchema } from './schema';

let _db: Database | null = null;

export function openDatabase(path: string): Database {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path, { create: true });
  applySchema(db);

  try { chmodSync(path, 0o600); } catch { /* ignore on systems without chmod */ }

  _db = db;
  return db;
}

export function getDb(): Database {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function generateId(): string {
  return crypto.randomUUID();
}
