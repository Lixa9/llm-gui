import { generateId, getDb, safeParseJson } from './db/index';
import { logger } from './logger';
import { intervalMs, parseScheduledDefinition } from './automation-definition';
import { runAutomation } from './automation-runner';
import type { AutomationRow } from './types';

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

interface ClaimedAutomation {
  row: AutomationRow;
  runId: string;
}

async function claimDueAutomation(): Promise<ClaimedAutomation | null> {
  const now = Date.now();
  return getDb().transaction(async db => {
    const row = await db.prepare('SELECT * FROM automations WHERE enabled=true AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED').get<AutomationRow>(now);
    if (!row) return null;
    const definition = parseScheduledDefinition(safeParseJson<unknown>(row.definition, {}));
    const runId = generateId();
    await db.prepare('UPDATE automations SET next_run_at=? WHERE id=?').run(now + intervalMs(definition), row.id);
    await db.prepare('INSERT INTO automation_runs (id, automation_id, status) VALUES (?, ?, ?)').run(runId, row.id, 'running');
    return { row, runId };
  });
}

async function schedulerTick(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const claimed = await claimDueAutomation();
    if (claimed) await runAutomation(claimed.row, 'scheduled', undefined, claimed.runId);
  } catch (error) {
    logger.error('Automation scheduler tick failed', { error: String(error) });
  } finally {
    schedulerRunning = false;
  }
}

export async function initScheduler(): Promise<void> {
  const rows = await getDb().prepare('SELECT id, definition FROM automations WHERE enabled=true AND deleted_at IS NULL AND next_run_at IS NULL').all<{ id: string; definition: unknown }>();
  for (const row of rows) {
    const definition = parseScheduledDefinition(safeParseJson<unknown>(row.definition, {}));
    await getDb().prepare('UPDATE automations SET next_run_at=? WHERE id=? AND next_run_at IS NULL').run(Date.now() + intervalMs(definition), row.id);
  }
  schedulerTimer = setInterval(() => { void schedulerTick(); }, 30_000);
  schedulerTimer.unref();
  logger.info('Automation scheduler initialized', { count: rows.length });
}

export function stopScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
