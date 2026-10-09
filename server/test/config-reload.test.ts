import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const configDir = await mkdtemp(join(tmpdir(), 'llm-gui-config-'));
process.env.CONFIG_DIR = configDir;

const { getConfig, loadConfig, reloadConfig, refreshChangedConfiguration } = await import('../src/config.ts');
const { DEFAULT_AUTO_TITLE_PROMPT } = await import('../src/title-request.ts');

async function writeConfigs(appName: string, conversationYaml = ''): Promise<void> {
  await Promise.all([
    writeFile(join(configDir, 'config.yaml'), `app:\n  name: ${JSON.stringify(appName)}\n  base_url: http://localhost:3000\nopenai:\n  base_url: ''\nstorage:\n  quota: '0'\n${conversationYaml}`),
    writeFile(join(configDir, 'models.yaml'), 'models: []\n'),
    writeFile(join(configDir, 'prompts.yaml'), `prompts:\n  - name: ${JSON.stringify(`${appName} prompt`)}\n    content: test\n    allowed_roles: [user]\n`),
    writeFile(join(configDir, 'presets.yaml'), 'presets: []\n'),
    writeFile(join(configDir, 'automations.yaml'), 'automations: []\n'),
  ]);
}

test.after(async () => {
  await rm(configDir, { recursive: true, force: true });
});

test('unchanged periodic checks avoid reconciliation and changed checks are coalesced', async () => {
  await writeConfigs('Before periodic');
  loadConfig();
  let reconciliations = 0;
  const dependencies = { reconcile: async () => { reconciliations++; }, invalidateCaches: async () => {} };
  await refreshChangedConfiguration(dependencies);
  assert.equal(reconciliations, 0);
  await writeConfigs('After periodic');
  await Promise.all(Array.from({ length: 8 }, () => refreshChangedConfiguration(dependencies)));
  assert.equal(reconciliations, 1);
  assert.equal(getConfig().app.name, 'After periodic');
  await refreshChangedConfiguration(dependencies);
  assert.equal(reconciliations, 1);
  await writeFile(join(configDir, 'models.yaml'), '# formatting change only\nmodels: []\n');
  await refreshChangedConfiguration(dependencies);
  assert.equal(reconciliations, 1);
  await writeFile(join(configDir, 'config.yaml'), 'app: [invalid\n');
  await refreshChangedConfiguration(dependencies);
  assert.equal(getConfig().app.name, 'After periodic');
  assert.equal(reconciliations, 1);
});

test('successful reload reconciles the candidate before committing it', async () => {
  await writeConfigs('Before');
  loadConfig();
  await writeConfigs('After');

  let reconciledName = '';
  const reloaded = await reloadConfig({
    reconcile: async candidate => { reconciledName = candidate.app.name; },
    invalidateCaches: async () => {},
  });

  assert.equal(reloaded, true);
  assert.equal(reconciledName, 'After');
  assert.equal(getConfig().app.name, 'After');
  assert.equal(getConfig().conversation.generation_max_duration_ms, 30 * 60 * 1000);
  assert.equal(getConfig().conversation.generation_idle_timeout_ms, 2 * 60 * 1000);
  assert.equal(getConfig().conversation.generation_max_attempts, 3);
});

test('invalid reload keeps the last valid configuration', async () => {
  await writeConfigs('Stable');
  loadConfig();
  await writeFile(join(configDir, 'config.yaml'), 'app: [invalid\n');

  const reloaded = await reloadConfig({
    reconcile: async () => assert.fail('invalid config must not be reconciled'),
    invalidateCaches: async () => {},
  });

  assert.equal(reloaded, false);
  assert.equal(getConfig().app.name, 'Stable');
});

test('reload requests are serialized', async () => {
  await writeConfigs('Queued');
  loadConfig();
  let active = 0;
  let maxActive = 0;
  const reconcile = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
  };

  const results = await Promise.all([
    reloadConfig({ reconcile, invalidateCaches: async () => {} }),
    reloadConfig({ reconcile, invalidateCaches: async () => {} }),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(maxActive, 1);
});

test('auto-title defaults to disabled without assuming an installed model', async () => {
  await writeConfigs('No title model');
  loadConfig();
  assert.equal(getConfig().conversation.auto_title, false);
  assert.equal(getConfig().conversation.auto_title_model, undefined);
  assert.equal(getConfig().conversation.auto_title_prompt, DEFAULT_AUTO_TITLE_PROMPT);
});

test('enabled auto-title requires an explicit nonempty model', async () => {
  for (const modelYaml of ['', '  auto_title_model: ""\n', '  auto_title_model: "   "\n', '  auto_title_model: null\n', '  auto_title_model: 123\n', `  auto_title_model: ${JSON.stringify('x'.repeat(301))}\n`]) {
    await writeConfigs('Invalid title model', `conversation:\n  auto_title: true\n${modelYaml}`);
    assert.throws(() => loadConfig(), /auto_title_model/);
  }
  await writeConfigs('Unset title model environment', 'conversation:\n  auto_title: true\n  auto_title_model: "${LLM_GUI_TEST_UNSET_TITLE_MODEL}"\n');
  const previousValue = process.env.LLM_GUI_TEST_UNSET_TITLE_MODEL;
  delete process.env.LLM_GUI_TEST_UNSET_TITLE_MODEL;
  try {
    assert.throws(() => loadConfig(), /auto_title_model/);
  } finally {
    if (previousValue !== undefined) process.env.LLM_GUI_TEST_UNSET_TITLE_MODEL = previousValue;
  }
});

test('auto-title accepts an explicit model and custom multiline system prompt', async () => {
  await writeConfigs('Custom titles', 'conversation:\n  auto_title: true\n  auto_title_model: " custom-title-model "\n  auto_title_prompt: |\n    Write a concise German title.\n    Return only the title.\n');
  loadConfig();
  assert.equal(getConfig().conversation.auto_title_model, 'custom-title-model');
  assert.equal(getConfig().conversation.auto_title_prompt, 'Write a concise German title.\nReturn only the title.');
});

test('auto-title validates model references when a registry is configured', async () => {
  await writeConfigs('Title registry', 'conversation:\n  auto_title: true\n  auto_title_model: title-model\n');
  await writeFile(join(configDir, 'models.yaml'), 'models:\n  - {id: chat-model, display_name: Chat}\n');
  assert.throws(() => loadConfig(), /auto_title_model references an unconfigured model: title-model/);
  await writeFile(join(configDir, 'models.yaml'), 'models:\n  - {id: title-model, display_name: Titles, allowed_roles: [admin]}\n');
  loadConfig();
  assert.equal(getConfig().conversation.auto_title_model, 'title-model');
});

test('invalid auto-title settings never replace the active configuration', async () => {
  const stableYaml = 'conversation:\n  auto_title: true\n  auto_title_model: stable-title-model\n  auto_title_prompt: Stable title instructions\n';
  for (const invalidYaml of [
    'conversation:\n  auto_title: true\n',
    'conversation:\n  auto_title: true\n  auto_title_model: ""\n',
    'conversation:\n  auto_title: true\n  auto_title_model: next-model\n  auto_title_prompt: "   "\n',
    'conversation:\n  auto_title: true\n  auto_title_model: next-model\n  auto_title_prompt: null\n',
    `conversation:\n  auto_title: true\n  auto_title_model: next-model\n  auto_title_prompt: ${JSON.stringify('x'.repeat(10001))}\n`,
  ]) {
    await writeConfigs('Stable titles', stableYaml);
    loadConfig();
    await writeConfigs('Invalid titles', invalidYaml);
    assert.throws(() => loadConfig(), /auto_title_model|auto_title_prompt/);
    assert.equal(await reloadConfig({ reconcile: async () => assert.fail('invalid titles activated'), invalidateCaches: async () => {} }), false);
    assert.equal(getConfig().conversation.auto_title_model, 'stable-title-model');
    assert.equal(getConfig().conversation.auto_title_prompt, 'Stable title instructions');
  }
});

test('auto-title model and prompt reload together', async () => {
  await writeConfigs('Original titles', 'conversation:\n  auto_title: true\n  auto_title_model: original-model\n');
  loadConfig();
  await writeConfigs('New titles', 'conversation:\n  auto_title: true\n  auto_title_model: new-model\n  auto_title_prompt: New title instructions\n');
  assert.equal(await reloadConfig({ reconcile: async () => {}, invalidateCaches: async () => {} }), true);
  assert.equal(getConfig().conversation.auto_title_model, 'new-model');
  assert.equal(getConfig().conversation.auto_title_prompt, 'New title instructions');
});

test('invalid collection roots, model capabilities, duplicates, and references never activate', async () => {
  for (const models of ['models: null\n', 'model: []\n', 'models: [wrong]\n', 'models:\n  - id: test\n    display_name: Test\n    capabilities: {native_pdf: true, vision: false}\n', 'models:\n  - {id: test, display_name: Test}\n  - {id: test, display_name: Duplicate}\n']) {
    await writeConfigs('Stable'); loadConfig();
    await writeFile(join(configDir,'models.yaml'),models);
    assert.equal(await reloadConfig({reconcile:async()=>assert.fail('invalid config activated'),invalidateCaches:async()=>{}}),false);
    assert.equal(getConfig().app.name,'Stable');
  }
  await writeConfigs('References');loadConfig();
  await writeFile(join(configDir,'models.yaml'),'models:\n  - {id: test, display_name: Test, allowed_roles: [admin]}\n');
  await writeFile(join(configDir,'presets.yaml'),'presets:\n  - {name: Wrong, base_model_id: missing, allowed_roles: [admin]}\n');
  assert.equal(await reloadConfig({reconcile:async()=>assert.fail(),invalidateCaches:async()=>{}}),false);
});


test('latest_only is rejected and legacy full configuration is normalized away', async () => {
  await writeConfigs('Full history');
  await writeFile(join(configDir, 'models.yaml'), 'models:\n  - {id: test, display_name: Test, history_mode: full}\n');
  loadConfig();
  assert.equal('history_mode' in getConfig().models![0], false);
  await writeFile(join(configDir, 'models.yaml'), 'models:\n  - {id: test, display_name: Test, history_mode: latest_only}\n');
  assert.throws(() => loadConfig(), /latest_only is no longer supported/);
  assert.equal(await reloadConfig({reconcile:async()=>assert.fail('obsolete history mode activated'),invalidateCaches:async()=>{}}), false);
  assert.equal(getConfig().app.name, 'Full history');
});
