import { getConfig } from './config';
import { getDb, generateId, safeParseJson } from './db/index';
import { logger } from './logger';
import { parseScheduledDefinition } from './automation-definition';
import { findAllowedModel } from './models';
import type { AutomationRow, AutomationRunRow, Role, ScheduledDefinition } from './types';

function makeConversationTitle(name: string): string {
  return `${name} — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

async function resolveOwnerRole(ownerSub: string): Promise<Role | null> {
  const owner = await getDb().prepare('SELECT last_known_role FROM users WHERE sub=?').get<{ last_known_role: Role }>(ownerSub);
  return owner?.last_known_role ?? null;
}

function visibleRoles(row: AutomationRow): Role[] {
  const roles = safeParseJson<Role[] | null>(row.visible_to, null);
  return roles?.length ? roles : ['admin', 'user'];
}

async function assertModelAccess(row: AutomationRow, definition: ScheduledDefinition, ownerRole?: Role): Promise<void> {
  if (row.owner_sub !== null) {
    const role = ownerRole ?? await resolveOwnerRole(row.owner_sub);
    if (!role || !await findAllowedModel(definition.model, role)) {
      throw new Error('Automation model is not available for the owner role');
    }
    return;
  }

  for (const role of visibleRoles(row)) {
    if ((role !== 'admin' && role !== 'user') || !await findAllowedModel(definition.model, role)) {
      throw new Error(`Automation model is not available for role: ${role}`);
    }
  }
}

export async function runAutomation(
  row: AutomationRow,
  source: 'scheduled' | 'manual',
  ownerRole?: Role,
  claimedRunId?: string,
): Promise<AutomationRunRow> {
  const db = getDb();
  const runId = claimedRunId ?? generateId();
  if (!claimedRunId) {
    await db.prepare('INSERT INTO automation_runs (id, automation_id, status) VALUES (?, ?, ?)').run(runId, row.id, 'running');
  }

  try {
    const definition = parseScheduledDefinition(row.definition);
    await assertModelAccess(row, definition, ownerRole);
    if (row.owner_sub === null) {
      void executeSystemAutomationRun(row, runId).catch(error => logger.error('System automation failed', { error: String(error) }));
    } else {
      const convId = generateId();
      await db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, false, ?)').run(convId, row.owner_sub, makeConversationTitle(row.name), definition.model || null);
      await db.prepare('UPDATE automation_runs SET conversation_id=? WHERE id=?').run(convId, runId);
      void executePersonalAutomationRun(row, convId, runId).catch(error => logger.error('Personal automation failed', { error: String(error) }));
    }
  } catch (error) {
    await db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(error), runId);
    throw error;
  }
  const run = await db.prepare('SELECT * FROM automation_runs WHERE id=?').get<AutomationRunRow>(runId);
  if (!run) throw new Error(`Could not create ${source} automation run`);
  return run;
}

async function executeSystemAutomationRun(row: AutomationRow, runId: string): Promise<void> {
  const db = getDb();
  try {
    const def = parseScheduledDefinition(row.definition);
    const subscribers = await db.prepare('SELECT user_sub FROM user_automation_subscriptions WHERE automation_id=? AND enabled=true').all<{ user_sub: string }>(row.id);
    if (subscribers.length) {
      const result = await fetchCompletion(def);
      for (const subscriber of subscribers) {
        const convId = generateId();
        await db.prepare('INSERT INTO conversations (id, owner_sub, title, title_auto, model_id) VALUES (?, ?, ?, false, ?)').run(convId, subscriber.user_sub, makeConversationTitle(row.name), def.model || null);
        await storeConversationResult(convId, def.user_prompt, result.assistantText, def.model);
      }
    }
    await db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
  } catch (error) {
    await db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(error), runId);
  }
}

async function executePersonalAutomationRun(row: AutomationRow, convId: string, runId: string): Promise<void> {
  const db = getDb();
  try {
    const def = parseScheduledDefinition(row.definition);
    const result = await fetchCompletion(def);
    await storeConversationResult(convId, def.user_prompt, result.assistantText, def.model);
    await db.prepare('UPDATE automation_runs SET status=? WHERE id=?').run('done', runId);
  } catch (error) {
    await db.prepare('UPDATE automation_runs SET status=?, error=? WHERE id=?').run('error', String(error), runId);
  }
}

async function storeConversationResult(
  convId: string,
  userPrompt: string,
  assistantText: string,
  model: string,
): Promise<void> {
  const db = getDb();
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, status) VALUES (?, ?, ?, ?, ?, ?)').run(generateId(), convId, 'user', JSON.stringify([{ type: 'text', text: userPrompt }]), userPrompt, 'done');
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, content_text, model, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(generateId(), convId, 'assistant', JSON.stringify([{ type: 'text', text: assistantText }]), assistantText, model, 'done');
}

async function fetchCompletion(def: ScheduledDefinition): Promise<{ assistantText: string }> {
  const cfg = getConfig();
  const messages: unknown[] = [];
  if (def.system_prompt) messages.push({ role: 'system', content: def.system_prompt });
  messages.push({ role: 'user', content: def.user_prompt });
  const response = await fetch(`${cfg.openai.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { ...(cfg.openai.api_key ? { Authorization: `Bearer ${cfg.openai.api_key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: def.model, messages, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`upstream error: ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { assistantText: data.choices?.[0]?.message?.content ?? '' };
}
