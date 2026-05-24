import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { dirname } from 'path';
import { applySchema } from './schema';

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

export function getDb(): Db {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function generateId(): string {
  return crypto.randomUUID();
}
