import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { logger } from './logger';

export function reconcileYaml(): void {
  const cfg = getConfig();
  const db = getDb();

  // Reconcile prompts
  const yamlPrompts = cfg.prompts ?? [];
  const dbPrompts = db.prepare(
    "SELECT id, name, content, visible_to, deleted_at FROM system_prompts WHERE owner_sub IS NULL"
  ).all() as { id: string; name: string; content: string; visible_to: string | null; deleted_at: number | null }[];

  const dbByName = new Map(dbPrompts.map(p => [p.name, p]));
  const yamlNames = new Set(yamlPrompts.map(p => p.name));

  for (const yp of yamlPrompts) {
    const existing = dbByName.get(yp.name);
    const visibleTo = JSON.stringify(yp.visible_to ?? ['admin', 'user']);
    if (!existing) {
      db.prepare(
        'INSERT INTO system_prompts (id, owner_sub, name, content, visible_to) VALUES (?, NULL, ?, ?, ?)'
      ).run(generateId(), yp.name, yp.content, visibleTo);
    } else {
      const changed = existing.content !== yp.content || existing.visible_to !== visibleTo || existing.deleted_at !== null;
      if (changed) {
        db.prepare('UPDATE system_prompts SET content=?, visible_to=?, deleted_at=NULL WHERE id=?')
          .run(yp.content, visibleTo, existing.id);
      }
    }
  }

  for (const dp of dbPrompts) {
    if (!yamlNames.has(dp.name) && dp.deleted_at === null) {
      db.prepare('UPDATE system_prompts SET deleted_at=? WHERE id=?').run(Date.now(), dp.id);
    }
  }

  // Reconcile automations
  const yamlAutomations = cfg.automations ?? [];
  const dbAutomations = db.prepare(
    "SELECT id, name, definition, deleted_at FROM automations WHERE owner_sub IS NULL"
  ).all() as { id: string; name: string; definition: string; deleted_at: number | null }[];

  const dbAutoByName = new Map(dbAutomations.map(a => [a.name, a]));
  const yamlAutoNames = new Set(yamlAutomations.map(a => a.name));

  for (const ya of yamlAutomations) {
    const existing = dbAutoByName.get(ya.name);
    const definition = JSON.stringify(ya);
    if (!existing) {
      db.prepare(
        'INSERT INTO automations (id, owner_sub, name, type, definition) VALUES (?, NULL, ?, ?, ?)'
      ).run(generateId(), ya.name, ya.type ?? 'scheduled', definition);
    } else {
      if (existing.definition !== definition || existing.deleted_at !== null) {
        db.prepare('UPDATE automations SET definition=?, deleted_at=NULL WHERE id=?')
          .run(definition, existing.id);
      }
    }
  }

  for (const da of dbAutomations) {
    if (!yamlAutoNames.has(da.name) && da.deleted_at === null) {
      db.prepare('UPDATE automations SET deleted_at=? WHERE id=?').run(Date.now(), da.id);
    }
  }

  logger.info('YAML reconciliation complete', {
    prompts: yamlPrompts.length,
    automations: yamlAutomations.length,
  });
}
