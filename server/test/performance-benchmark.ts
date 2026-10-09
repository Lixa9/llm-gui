import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { responseCompression } from '../src/http-performance.ts';
import { serializeJson } from '../src/serialization.ts';

const directory = await mkdtemp(join(tmpdir(), 'llm-benchmark-'));
process.env.CONFIG_DIR = directory;
await writeFile(join(directory, 'config.yaml'), 'app:\n  name: Benchmark\nopenai:\n  base_url: ""\n');
for (const key of ['models', 'prompts', 'presets', 'automations'])
  await writeFile(join(directory, `${key}.yaml`), `${key}: []\n`);
const { loadConfig } = await import('../src/config.ts');
loadConfig();
const { createRequestBudget } = await import('../src/attachment-transport.ts');
const model = { id: 'test', display_name: 'Test', allowed_roles: ['user' as const] };

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 1000) / 1000;
  return { samples: samples.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99) };
}

try {
  for (const variant of ['legacy', 'optimized']) {
    const app = new Hono();
    app.use('*', variant === 'legacy' ? compress() : responseCompression);
    app.get('/health', context => context.json({ status: 'ok' }));
    const samples: number[] = [];
    let responseBytes = 0;
    for (let iteration = 0; iteration < 550; iteration++) {
      const start = performance.now();
      const response = await app.request('/health', { headers: { 'Accept-Encoding': 'gzip' } });
      responseBytes = (await response.arrayBuffer()).byteLength;
      if (iteration >= 50) samples.push(performance.now() - start);
    }
    console.log(JSON.stringify({ case: 'health-in-process', variant, response_bytes: responseBytes, ...summarize(samples) }));
  }

  const messages = Array.from({ length: 40 }, () => ({
    role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(512 * 1024)}` } }],
  }));
  await serializeJson({ warmup: 'x'.repeat(70000) });
  for (const variant of ['legacy', 'optimized']) {
    const start = performance.now();
    let callbacks = 0;
    let maximumDelay = 0;
    let expected = performance.now() + 5;
    const timer = setInterval(() => {
      maximumDelay = Math.max(maximumDelay, performance.now() - expected);
      expected = performance.now() + 5;
      callbacks++;
    }, 5);
    let bytes = 0;
    try {
      if (variant === 'legacy') {
        const prefix = [];
        for (const message of messages) {
          prefix.push(message);
          bytes = Buffer.byteLength(JSON.stringify(prefix));
        }
      } else {
        const budget = createRequestBudget(model);
        for (const message of messages) await budget.add(message);
        bytes = budget.finish().bytes;
      }
      const duration = performance.now() - start;
      await new Promise(resolve => setTimeout(resolve, 10));
      console.log(JSON.stringify({ case: 'image-history-budget', variant, messages: messages.length, bytes,
        duration_ms: Math.round(duration * 1000) / 1000, timer_callbacks: callbacks,
        max_timer_delay_ms: Math.round(maximumDelay * 1000) / 1000 }));
      assert.equal(bytes, Buffer.byteLength(JSON.stringify(messages)));
    } finally { clearInterval(timer); }
  }

  const target = process.argv.find(argument => argument.startsWith('--url='))?.slice(6);
  if (target) {
    for (const encoding of ['gzip', 'identity']) {
      const samples: number[] = [];
      for (let iteration = 0; iteration < 210; iteration++) {
        const start = performance.now();
        const response: Response = await fetch(target, { headers: { 'Accept-Encoding': encoding }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
        if (iteration >= 10) samples.push(performance.now() - start);
      }
      console.log(JSON.stringify({ case: 'health-http', encoding, ...summarize(samples) }));
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
