import { getDb, generateId } from './db/index';
import type { TxDb } from './db/index';
import { getConfig } from './config';
import { scheduledDefinitionSchema } from './automation-definition';
import { logger } from './logger';

type ExistingResource = {
  id: string;
  name: string;
  visible_to: unknown;
  deleted_at: number | null;
};

function rolesJson(roles: string[] | undefined): string {
  return JSON.stringify(roles ?? ['admin', 'user']);
}

async function reconcilePrompts(db: TxDb, config: ReturnType<typeof getConfig>): Promise<number> {
  const prompts = config.prompts ?? [];
  const existing = await db.prepare('SELECT id, name, content, visible_to, deleted_at FROM system_prompts WHERE owner_sub IS NULL').all<ExistingResource & { content: string }>();
  const byName = new Map(existing.map(row => [row.name, row]));
  const names = new Set(prompts.map(prompt => prompt.name));

  for (const prompt of prompts) {
    const visibleTo = rolesJson(prompt.allowed_roles);
    const current = byName.get(prompt.name);
    if (!current) {
      await db.prepare('INSERT INTO system_prompts (id, owner_sub, name, content, visible_to) VALUES (?, NULL, ?, ?, ?::jsonb)')
        .run(generateId(), prompt.name, prompt.content, visibleTo);
    } else if (current.content !== prompt.content || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
      await db.prepare('UPDATE system_prompts SET content=?, visible_to=?::jsonb, deleted_at=NULL WHERE id=?').run(prompt.content, visibleTo, current.id);
    }
  }
  for (const current of existing) {
    if (!names.has(current.name) && current.deleted_at === null) {
      await db.prepare('UPDATE system_prompts SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }
  }
  return prompts.length;
}

async function reconcilePresets(db: TxDb, config: ReturnType<typeof getConfig>): Promise<number> {
  const presets = config.presets ?? [];
  const existing = await db.prepare('SELECT id, name, base_model_id, system_prompt, visible_to, deleted_at FROM model_presets WHERE owner_sub IS NULL').all<ExistingResource & { base_model_id: string; system_prompt: string }>();
  const byName = new Map(existing.map(row => [row.name, row]));
  const names = new Set(presets.map(preset => preset.name));

  for (const preset of presets) {
    const visibleTo = rolesJson(preset.allowed_roles);
    const systemPrompt = preset.system_prompt ?? '';
    const current = byName.get(preset.name);
    if (!current) {
      await db.prepare('INSERT INTO model_presets (id, owner_sub, name, base_model_id, system_prompt, visible_to) VALUES (?, NULL, ?, ?, ?, ?::jsonb)')
        .run(generateId(), preset.name, preset.base_model_id, systemPrompt, visibleTo);
    } else if (current.base_model_id !== preset.base_model_id || current.system_prompt !== systemPrompt || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
      await db.prepare('UPDATE model_presets SET base_model_id=?, system_prompt=?, visible_to=?::jsonb, deleted_at=NULL WHERE id=?')
        .run(preset.base_model_id, systemPrompt, visibleTo, current.id);
    }
  }
  for (const current of existing) {
    if (!names.has(current.name) && current.deleted_at === null) {
      await db.prepare('UPDATE model_presets SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }
  }
  return presets.length;
}

async function reconcileAutomations(db: TxDb, config: ReturnType<typeof getConfig>): Promise<number> {
  const automations = config.automations ?? [];
  const existing = await db.prepare('SELECT id, name, definition, visible_to, deleted_at FROM automations WHERE owner_sub IS NULL').all<ExistingResource & { definition: unknown }>();
  const byName = new Map(existing.map(row => [row.name, row]));
  const names = new Set(automations.map(automation => automation.name));

  for (const automation of automations) {
    const visibleTo = rolesJson(automation.allowed_roles);
    const { name: _name, allowed_roles: _roles, ...rawDefinition } = automation;
    const definition = JSON.stringify(scheduledDefinitionSchema.parse(rawDefinition));
    const current = byName.get(automation.name);
    if (!current) {
      await db.prepare('INSERT INTO automations (id, owner_sub, name, type, definition, visible_to) VALUES (?, NULL, ?, ?, ?::jsonb, ?::jsonb)')
        .run(generateId(), automation.name, 'scheduled', definition, visibleTo);
    } else if (JSON.stringify(current.definition) !== definition || JSON.stringify(current.visible_to) !== visibleTo || current.deleted_at !== null) {
      await db.prepare('UPDATE automations SET definition=?::jsonb, visible_to=?::jsonb, deleted_at=NULL WHERE id=?').run(definition, visibleTo, current.id);
    }
  }
  for (const current of existing) {
    if (!names.has(current.name) && current.deleted_at === null) {
      await db.prepare('UPDATE automations SET deleted_at=? WHERE id=?').run(Date.now(), current.id);
    }
  }
  return automations.length;
}

/** Reconcile deployment-owned YAML definitions. The lock makes startup safe across replicas. */
export async function reconcileYaml(config = getConfig()): Promise<void> {
  await getDb().withAdvisoryLock('llm-gui-config-reconcile', async db => {
    const prompts = await reconcilePrompts(db, config);
    const presets = await reconcilePresets(db, config);
    const automations = await reconcileAutomations(db, config);
    logger.info('YAML reconciliation complete', { prompts, presets, automations });
  });
}
