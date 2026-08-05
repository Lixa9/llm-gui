import assert from 'node:assert/strict';
import test from 'node:test';
import { intervalMs, nextRunAt, parseScheduledDefinition, scheduledDefinitionSchema } from '../src/automation-definition';

test('scheduled definitions are validated and normalized', () => {
  const parsed = scheduledDefinitionSchema.parse({
    interval: '2',
    unit: 'hours',
    model: 'test-model',
    user_prompt: 'Run this task',
  });

  assert.deepEqual(parsed, {
    interval: 2,
    unit: 'hours',
    model: 'test-model',
    system_prompt: '',
    user_prompt: 'Run this task',
  });
});

test('invalid stored definitions fall back safely', () => {
  assert.deepEqual(parseScheduledDefinition({ interval: 0, unit: 'months' }), {
    interval: 1,
    unit: 'days',
    model: '',
    system_prompt: '',
    user_prompt: '',
  });
});

test('schedule intervals and next-run timestamps use the same calculation', () => {
  const definition = { interval: 3, unit: 'weeks' as const, model: 'model', user_prompt: 'prompt' };
  const now = 1_000_000;
  assert.equal(intervalMs(definition), 3 * 7 * 86_400_000);
  assert.equal(nextRunAt(definition, now), now + intervalMs(definition));
});
