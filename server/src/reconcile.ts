import { getDb, generateId } from './db/index';
import { getConfig } from './config';
import { logger } from './logger';

/** Reconcile deployment-owned YAML definitions. The lock makes startup safe across replicas. */
export async function reconcileYaml(): Promise<void> {
  const rootDb = getDb();
  await rootDb.withAdvisoryLock('llm-gui-config-reconcile', async db => {
    const cfg = getConfig();
    const prompts = cfg.prompts ?? [];
    const existingPrompts = await db.prepare('SELECT id, name, content, visible_to, deleted_at FROM system_prompts WHERE owner_sub IS NULL').all<{ id: string; name: string; content: string; visible_to: unknown; deleted_at: number | null }>();
    const promptByName = new Map(existingPrompts.map(row => [row.name, row]));
    const promptNames = new Set(prompts.map(prompt => prompt.name));
    for (const prompt of prompts) {
      const visibleTo = JSON.stringify(prompt.allowed_roles ?? ['admin', 'user']);
      const current = promptByName.get(prompt.name);
      if (!current) {
        await db.prepare('INSERT INTO system_prompts (id, owner_sub, name, content, visible_to) VALUES (?, NULL, ?, ?, ?::jsonb)')
          .run(generateId(), prompt.name, prompt.content, visibleTo);
      } else if (current.content !== prompt.content || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
        await db.prepare('UPDATE system_prompts SET content=?, visible_to=?::jsonb, deleted_at=NULL WHERE id=?').run(prompt.content, visibleTo, current.id);
      }
    }
    for (const current of existingPrompts) {
      if (!promptNames.has(current.name) && current.deleted_at === null) await db.prepare('UPDATE system_prompts SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }

    const presets = cfg.presets ?? [];
    const existingPresets = await db.prepare('SELECT id, name, base_model_id, system_prompt, visible_to, deleted_at FROM model_presets WHERE owner_sub IS NULL').all<{ id: string; name: string; base_model_id: string; system_prompt: string; visible_to: unknown; deleted_at: number | null }>();
    const presetByName = new Map(existingPresets.map(row => [row.name, row]));
    const presetNames = new Set(presets.map(preset => preset.name));
    for (const preset of presets) {
      const visibleTo = JSON.stringify(preset.allowed_roles ?? ['admin', 'user']);
      const systemPrompt = preset.system_prompt ?? '';
      const current = presetByName.get(preset.name);
      if (!current) {
        await db.prepare('INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt, visible_to) VALUES (?, NULL, ?, ?, ?, ?::jsonb)')
          .run(generateId(), preset.name, preset.base_model_id, systemPrompt, visibleTo);
      } else if (current.base_model_id !== preset.base_model_id || current.system_prompt !== systemPrompt || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
        await db.prepare('UPDATE model_presets SET base_model_id=?, system_prompt=?, visible_to=?::jsonb, deleted_at=NULL WHERE id=?')
          .run(preset.base_model_id, systemPrompt, visibleTo, current.id);
      }
    }
    for (const current of existingPresets) {
      if (!presetNames.has(current.name) && current.deleted_at === null) await db.prepare('UPDATE model_presets SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }

    const automations = cfg.automations ?? [];
    const existingAutomations = await db.prepare('SELECT id, name, definition, visible_to, deleted_at FROM automations WHERE owner_sub IS NULL').all<{ id: string; name: string; definition: unknown; visible_to: unknown; deleted_at: number | null }>();
    const automationByName = new Map(existingAutomations.map(row => [row.name, row]));
    const automationNames = new Set(automations.map(automation => automation.name));
    for (const automation of automations) {
      const visibleTo = JSON.stringify(automation.allowed_roles ?? ['admin', 'user']);
      const { name: _name, allowed_roles: _roles, ...operationalDefinition } = automation;
      const definition = JSON.stringify(operationalDefinition);
      const current = automationByName.get(automation.name);
      if (!current) {
        await db.prepare('INSERT INTO automations (id, owner_sub, name, type, definition, visible_to) VALUES (?, NULL, ?, ?, ?::jsonb, ?::jsonb)')
          .run(generateId(), automation.name, 'scheduled', definition, visibleTo);
      } else if (JSON.stringify(current.definition) !== definition || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
        await db.prepare('UPDATE automations SET definition=?::jsonb, visible_to=?::jsonb, deleted_at=NULL WHERE id=?').run(definition, visibleTo, current.id);
      }
    }
    for (const current of existingAutomations) {
      if (!automationNames.has(current.name) && current.deleted_at === null) await db.prepare('UPDATE automations SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }

    logger.info('YAML reconciliation complete', { prompts: prompts.length, presets: presets.length, automations: automations.length });
  });
}
