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
    const visibleTo = JSON.stringify(yp.allowed_roles ?? ['admin', 'user']);
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

  // Reconcile presets
  const yamlPresets = cfg.presets ?? [];
  const dbPresets = db.prepare(
    "SELECT id, name, base_model_id, system_prompt, visible_to, deleted_at FROM model_presets WHERE owner_sub IS NULL"
  ).all() as { id: string; name: string; base_model_id: string; system_prompt: string; visible_to: string | null; deleted_at: number | null }[];

  const dbPresetByName = new Map(dbPresets.map(p => [p.name, p]));
  const yamlPresetNames = new Set(yamlPresets.map(p => p.name));

  for (const yp of yamlPresets) {
    const existing = dbPresetByName.get(yp.name);
    const visibleTo = JSON.stringify(yp.allowed_roles ?? ['admin', 'user']);
    const systemPrompt = yp.system_prompt ?? '';
    if (!existing) {
      db.prepare(
        'INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt, visible_to) VALUES (?, NULL, ?, ?, ?, ?)'
      ).run(generateId(), yp.name, yp.base_model_id, systemPrompt, visibleTo);
    } else {
      const changed = existing.base_model_id !== yp.base_model_id
        || existing.system_prompt !== systemPrompt
        || existing.visible_to !== visibleTo
        || existing.deleted_at !== null;
      if (changed) {
        db.prepare('UPDATE model_presets SET base_model_id=?, system_prompt=?, visible_to=?, deleted_at=NULL WHERE id=?')
          .run(yp.base_model_id, systemPrompt, visibleTo, existing.id);
      }
    }
  }

  for (const dp of dbPresets) {
    if (!yamlPresetNames.has(dp.name) && dp.deleted_at === null) {
      db.prepare('UPDATE model_presets SET deleted_at=? WHERE id=?').run(Date.now(), dp.id);
    }
  }

  // Reconcile automations
  const yamlAutomations = cfg.automations ?? [];
  const dbAutomations = db.prepare(
    "SELECT id, name, definition, visible_to, deleted_at FROM automations WHERE owner_sub IS NULL"
  ).all() as { id: string; name: string; definition: string; visible_to: string | null; deleted_at: number | null }[];

  const dbAutoByName = new Map(dbAutomations.map(a => [a.name, a]));
  const yamlAutoNames = new Set(yamlAutomations.map(a => a.name));

  for (const ya of yamlAutomations) {
    const existing = dbAutoByName.get(ya.name);
    const visibleTo = JSON.stringify(ya.allowed_roles ?? ['admin', 'user']);
    // Store only the operational definition, not the metadata fields
    const { name: _n, allowed_roles: _r, ...operationalDef } = ya;
    const definition = JSON.stringify(operationalDef);
    if (!existing) {
      db.prepare(
        'INSERT INTO automations (id, owner_sub, name, type, definition, visible_to) VALUES (?, NULL, ?, ?, ?, ?)'
      ).run(generateId(), ya.name, ya.type ?? 'scheduled', definition, visibleTo);
    } else {
      if (existing.definition !== definition || existing.visible_to !== visibleTo || existing.deleted_at !== null) {
        db.prepare('UPDATE automations SET definition=?, visible_to=?, deleted_at=NULL WHERE id=?')
          .run(definition, visibleTo, existing.id);
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
    presets: yamlPresets.length,
    automations: yamlAutomations.length,
  });
}
