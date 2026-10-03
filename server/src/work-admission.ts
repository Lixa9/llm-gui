import { getConfig, runtimeConfigurationIsCurrent } from './config.ts';
import { getDb, runTransaction, type TxDb } from './db/index.ts';

export class AdmissionError extends Error {}
const activeSql = `
  SELECT id, owner_sub FROM chat_generations WHERE status='running' AND lease_until>?
  UNION ALL SELECT r.id, a.owner_sub FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.status='running' AND r.lease_until>?
  UNION ALL SELECT j.id, c.owner_sub FROM conversation_title_jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='running' AND j.lease_until>?`;
/** Shared across job kinds and replicas. Claim and capacity check share one lock. */
export async function admittedClaim<T>(
  table: 'chat_generations' | 'automation_runs' | 'conversation_title_jobs',
  id: string,
  claim: (db: TxDb) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!(await runtimeConfigurationIsCurrent())) return undefined;
  return runTransaction(async (db) => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('provider-work-admission');
    const ownerQuery =
      table === 'chat_generations'
        ? 'SELECT owner_sub FROM chat_generations WHERE id=?'
        : table === 'automation_runs'
          ? 'SELECT a.owner_sub FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.id=?'
          : 'SELECT c.owner_sub FROM conversation_title_jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=?';
    const owner = await db.prepare(ownerQuery).get<{ owner_sub: string | null }>(id);
    if (!owner) return undefined;
    const now = Date.now();
    const active = await db.prepare(activeSql).all<{ id: string; owner_sub: string | null }>(now, now, now);
    const others = active.filter((job) => job.id !== id);
    const limits = getConfig().rate_limits;
    if (
      others.length >= limits.global_workers ||
      others.filter((job) => job.owner_sub === owner.owner_sub).length >= limits.workers_per_owner
    )
      return undefined;
    return claim(db);
  });
}
export async function assertQueueCapacity(db: TxDb): Promise<void> {
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('provider-queue-admission');
  const row = await db
    .prepare(
      `SELECT (
    (SELECT count(*) FROM chat_generations WHERE status IN ('queued','running')) +
    (SELECT count(*) FROM automation_runs WHERE status IN ('queued','running')) +
    (SELECT count(*) FROM conversation_title_jobs WHERE status IN ('queued','running'))
  )::int AS count`,
    )
    .get<{ count: number }>();
  if ((row?.count ?? 0) >= getConfig().rate_limits.max_queued_jobs)
    throw new AdmissionError('Generation queue is full. Try again shortly.');
}
