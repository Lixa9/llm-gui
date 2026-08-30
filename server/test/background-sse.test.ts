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
