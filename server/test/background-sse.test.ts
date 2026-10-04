import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundSseResponse } from '../src/background-sse.ts';
import { waitForBackgroundTasks } from '../src/lifecycle.ts';

test('tab close, navigation, or logout detaches SSE without cancelling the background task', async () => {
  let releaseTask!: () => void;
  const mayFinish = new Promise<void>(resolve => { releaseTask = resolve; });
  let taskFinished = false;
  let taskError: unknown;

  const response = createBackgroundSseResponse(
    { type: 'accepted' },
    async client => {
      await mayFinish;
      client.send({ type: 'delta', content: 'completed after disconnect' });
      taskFinished = true;
    },
    error => { taskError = error; },
  );

  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"accepted"/);
  await reader.cancel();

  releaseTask();
  await waitForBackgroundTasks(1_000);

  assert.equal(taskFinished, true);
  assert.equal(taskError, undefined);
});

test('connected clients continue to receive terminal events', async () => {
  const response = createBackgroundSseResponse(
    { type: 'accepted' },
    async client => {
      client.send({ type: 'delta', content: 'hello' });
      client.send({ type: 'done' });
    },
    error => assert.fail(error instanceof Error ? error : String(error)),
  );

  const body = await response.text();
  assert.match(body, /"type":"accepted"/);
  assert.match(body, /"type":"delta"/);
  assert.match(body, /"type":"done"/);
});

test('slow mock replies receive keep-alives until completion, with timer cleanup', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const response = createBackgroundSseResponse({ type: 'accepted' }, async client => {
    await waiting;
    client.send({ type: 'done', message: { content: 'hardcoded response' } });
  }, error => assert.fail(String(error)));
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /accepted/);
  t.mock.timers.tick(15_000);
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': keep-alive\n\n');
  t.mock.timers.tick(15_000);
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': keep-alive\n\n');
  release();
  await waitForBackgroundTasks(1_000);
  assert.match(new TextDecoder().decode((await reader.read()).value), /hardcoded response/);
  assert.equal((await reader.read()).done, true);
  t.mock.timers.tick(15_000);
  assert.equal((await reader.read()).done, true);
});

test('disconnect clears keep-alives while the background task continues', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const response = createBackgroundSseResponse({ type: 'accepted' }, async client => {
    await waiting;
    client.send({ type: 'done' });
    completed = true;
  }, error => assert.fail(String(error)));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  t.mock.timers.tick(60_000);
  release();
  await waitForBackgroundTasks(1_000);
  assert.equal(completed, true);
});

test('unexpected task failures produce an error event before closing', async () => {
  let caught: unknown;
  const response = createBackgroundSseResponse({ type: 'accepted' }, async () => {
    throw new Error('private internal failure');
  }, error => { caught = error; });
  const body = await response.text();
  assert.match(body, /"type":"error"/);
  assert.doesNotMatch(body, /private internal failure/);
  assert.equal((caught as Error).message, 'private internal failure');
});
