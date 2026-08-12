import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const configDir = await mkdtemp(join(tmpdir(), 'llm-gui-config-'));
process.env.CONFIG_DIR = configDir;

const { getConfig, loadConfig, reloadConfig } = await import('../src/config');

async function writeConfigs(appName: string): Promise<void> {
  await Promise.all([
    writeFile(join(configDir, 'config.yaml'), `app:\n  name: ${JSON.stringify(appName)}\n  base_url: http://localhost:3000\nopenai:\n  base_url: ''\nstorage:\n  quota: '0'\n`),
    writeFile(join(configDir, 'models.yaml'), 'models: []\n'),
    writeFile(join(configDir, 'prompts.yaml'), `prompts:\n  - name: ${JSON.stringify(`${appName} prompt`)}\n    content: test\n    allowed_roles: [user]\n`),
    writeFile(join(configDir, 'presets.yaml'), 'presets: []\n'),
    writeFile(join(configDir, 'automations.yaml'), 'automations: []\n'),
  ]);
}

test.after(async () => {
  await rm(configDir, { recursive: true, force: true });
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
