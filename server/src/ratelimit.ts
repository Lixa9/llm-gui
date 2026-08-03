import { getConfig } from './config';
import { getDb, generateId } from './db/index';

export interface RateLimitResult { allowed: boolean; reason?: string; }

function bucketStart(now: number, seconds: number): number {
  return Math.floor(now / (seconds * 1000)) * seconds * 1000;
}

export async function checkRateLimit(subject: string): Promise<RateLimitResult> {
  const cfg = getConfig().rate_limits;
  const now = Date.now();
  return getDb().transaction(async db => {
    await db.prepare('DELETE FROM stream_leases WHERE expires_at <= ?').run(now);
    const active = await db.prepare('SELECT COUNT(*)::int AS count FROM stream_leases WHERE subject=? AND expires_at>?').get<{ count: number }>(subject, now);
    if (cfg.concurrent_streams > 0 && (active?.count ?? 0) >= cfg.concurrent_streams) return { allowed: false, reason: 'Rate limit: too many concurrent streams' };

    for (const [seconds, limit, label] of [
      [60, cfg.requests_per_minute, 'minute'],
      [3600, cfg.requests_per_hour, 'hour'],
    ] as const) {
      if (limit <= 0) continue;
      const row = await db.prepare(`
        INSERT INTO rate_limit_counters (subject, bucket_start, window_seconds, requests)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(subject, bucket_start, window_seconds)
        DO UPDATE SET requests=rate_limit_counters.requests+1
        RETURNING requests
      `).get<{ requests: number }>(subject, bucketStart(now, seconds), seconds);
      if ((row?.requests ?? 0) > limit) return { allowed: false, reason: `Rate limit: too many requests per ${label}` };
    }
    return { allowed: true };
  });
}

export async function openStream(subject: string): Promise<string> {
  const id = generateId();
  await getDb().prepare('INSERT INTO stream_leases (id, subject, expires_at) VALUES (?, ?, ?)').run(id, subject, Date.now() + 30 * 60 * 1000);
  return id;
}

export async function closeStream(leaseId: string): Promise<void> {
  await getDb().prepare('DELETE FROM stream_leases WHERE id=?').run(leaseId);
}

export async function sweepBuckets(): Promise<void> {
  const now = Date.now();
  await getDb().prepare('DELETE FROM rate_limit_counters WHERE bucket_start < ?').run(now - 2 * 3_600_000);
  await getDb().prepare('DELETE FROM stream_leases WHERE expires_at <= ?').run(now);
}
