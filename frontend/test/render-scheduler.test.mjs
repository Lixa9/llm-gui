import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderScheduler } from '../src/lib/renderScheduler.ts';

test('streaming updates coalesce and the final render flushes immediately', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const values = [];
  const scheduler = createRenderScheduler(value => values.push(value));
  scheduler.update('first', true);
  scheduler.update('second', true);
  scheduler.update('latest', true);
  assert.deepEqual(values, ['first']);
  context.mock.timers.tick(49);
  assert.deepEqual(values, ['first']);
  context.mock.timers.tick(1);
  assert.deepEqual(values, ['first', 'latest']);
  scheduler.update('pending', true);
  scheduler.update('complete', false);
  assert.deepEqual(values, ['first', 'latest', 'complete']);
  context.mock.timers.tick(100);
  assert.deepEqual(values, ['first', 'latest', 'complete']);
  scheduler.destroy();
});

test('destroy cancels pending rendering when a message unmounts', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const values = [];
  const scheduler = createRenderScheduler(value => values.push(value));
  scheduler.update('first', true);
  scheduler.update('pending', true);
  scheduler.destroy();
  context.mock.timers.tick(100);
  assert.deepEqual(values, ['first']);
});
