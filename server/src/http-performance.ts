import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { compress } from 'hono/compress';
import type { MiddlewareHandler } from 'hono';
import { logger } from './logger.ts';

const compression = compress();

export const responseCompression: MiddlewareHandler = (context, next) =>
  context.req.path === '/health' ? next() : compression(context, next);

export const requestTiming: MiddlewareHandler = async (context, next) => {
  const start = performance.now();
  await next();
  logger.info('request', {
    method: context.req.method,
    path: context.req.path,
    status: context.res.status,
    ms: Math.round((performance.now() - start) * 1000) / 1000,
  });
};

export function startEventLoopMonitoring(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    logger.info('event_loop', {
      p95_ms: Math.round(histogram.percentile(95) / 1000) / 1000,
      max_ms: Math.round(histogram.max / 1000) / 1000,
    });
    histogram.reset();
  }, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
