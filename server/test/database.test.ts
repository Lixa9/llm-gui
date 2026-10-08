import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { Db } from '../src/db/index.ts';

function databaseFixture(failSql?: string) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let connections = 0;
  let releases = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql === failSql) throw new Error('query failed');
      return { rows: [{ answer: 42 }], rowCount: 1 };
    },
    release() { releases++; },
  };
  const pool = {
    async connect() { connections++; return client; },
  } as unknown as Pool;
  return {
    db: new Db(pool),
    queries,
    get connections() { return connections; },
    get releases() { return releases; },
  };
}

test('advisory lock and callback use one transaction and connection', async () => {
  const fixture = databaseFixture();
  const result = await fixture.db.withAdvisoryLock('quota:owner', async db => {
    return db.prepare('SELECT ?::int AS answer').get<{ answer: number }>(42);
  });
  assert.deepEqual(result, { answer: 42 });
  assert.deepEqual(fixture.queries, [
    { sql: 'BEGIN', params: undefined },
    { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['quota:owner'] },
    { sql: 'SELECT $1::int AS answer', params: [42] },
    { sql: 'COMMIT', params: undefined },
  ]);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases, 1);
});

test('advisory transaction rolls back and releases on callback failure', async () => {
  const fixture = databaseFixture();
  const failure = new Error('callback failed');
  await assert.rejects(fixture.db.withAdvisoryLock('quota:owner', async () => { throw failure; }), failure);
  assert.deepEqual(fixture.queries.map(query => query.sql), ['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext($1))', 'ROLLBACK']);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases, 1);
});

test('advisory transaction does not run the callback if locking fails', async () => {
  const fixture = databaseFixture('SELECT pg_advisory_xact_lock(hashtext($1))');
  let called = false;
  await assert.rejects(fixture.db.withAdvisoryLock('quota:owner', async () => { called = true; }), /query failed/);
  assert.equal(called, false);
  assert.equal(fixture.queries.at(-1)?.sql, 'ROLLBACK');
  assert.equal(fixture.releases, 1);
});

test('ordinary transactions retain commit and release behavior', async () => {
  const fixture = databaseFixture();
  assert.equal(await fixture.db.transaction(async () => 'saved'), 'saved');
  assert.deepEqual(fixture.queries.map(query => query.sql), ['BEGIN', 'COMMIT']);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases, 1);
});
