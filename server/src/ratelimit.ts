import { getConfig } from './config';

interface UserBucket {
  minuteTokens: number;
  hourTokens: number;
  concurrentStreams: number;
  lastMinuteReset: number;
  lastHourReset: number;
}

const buckets = new Map<string, UserBucket>();

function getBucket(sub: string): UserBucket {
  let b = buckets.get(sub);
  if (!b) {
    b = { minuteTokens: 0, hourTokens: 0, concurrentStreams: 0, lastMinuteReset: Date.now(), lastHourReset: Date.now() };
    buckets.set(sub, b);
  }
  return b;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

export function sweepBuckets() {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.lastHourReset > 7_200_000) buckets.delete(k);
  }
}

export function checkRateLimit(sub: string): RateLimitResult {
  const cfg = getConfig().rate_limits;
  const b = getBucket(sub);
  const now = Date.now();

  if (now - b.lastMinuteReset >= 60_000) {
    b.minuteTokens = 0;
    b.lastMinuteReset = now;
  }
  if (now - b.lastHourReset >= 3_600_000) {
    b.hourTokens = 0;
    b.lastHourReset = now;
  }

  if (cfg.requests_per_minute > 0 && b.minuteTokens >= cfg.requests_per_minute) {
    return { allowed: false, reason: 'Rate limit: too many requests per minute' };
  }
  if (cfg.requests_per_hour > 0 && b.hourTokens >= cfg.requests_per_hour) {
    return { allowed: false, reason: 'Rate limit: too many requests per hour' };
  }
  if (cfg.concurrent_streams > 0 && b.concurrentStreams >= cfg.concurrent_streams) {
    return { allowed: false, reason: 'Rate limit: too many concurrent streams' };
  }

  b.minuteTokens++;
  b.hourTokens++;
  return { allowed: true };
}

export function openStream(sub: string): void {
  const b = getBucket(sub);
  b.concurrentStreams++;
}

export function closeStream(sub: string): void {
  const b = getBucket(sub);
  if (b.concurrentStreams > 0) b.concurrentStreams--;
}
