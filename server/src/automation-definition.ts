import { z } from 'zod';
import type { ScheduledDefinition } from './types';

export const scheduledDefinitionSchema = z.object({
  interval: z.coerce.number().int().min(1),
  unit: z.enum(['hours', 'days', 'weeks']),
  model: z.string().trim().min(1),
  system_prompt: z.string().max(100_000).optional().default(''),
  user_prompt: z.string().min(1).max(100_000),
});

export const automationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  definition: scheduledDefinitionSchema,
});

const fallbackDefinition: ScheduledDefinition = {
  interval: 1,
  unit: 'days',
  model: '',
  system_prompt: '',
  user_prompt: '',
};

export function parseScheduledDefinition(value: unknown): ScheduledDefinition {
  const parsed = scheduledDefinitionSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...fallbackDefinition };
}

export function intervalMs(definition: ScheduledDefinition): number {
  const interval = Math.max(1, Math.floor(definition.interval || 1));
  if (definition.unit === 'hours') return interval * 3_600_000;
  if (definition.unit === 'weeks') return interval * 7 * 86_400_000;
  return interval * 86_400_000;
}

export function nextRunAt(definition: ScheduledDefinition, now = Date.now()): number {
  return now + intervalMs(definition);
}
