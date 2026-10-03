import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'llm-processing-test-'));
process.env.CONFIG_DIR = configDir;
await writeFile(
  join(configDir, 'config.yaml'),
  'app:\n  name: Test\nattachments:\n  processing_workers: 1\n',
);
for (const key of ['models', 'prompts', 'presets', 'automations'])
  await writeFile(join(configDir, `${key}.yaml`), `${key}: []\n`);
const { loadConfig } = await import('../src/config.ts');
loadConfig();
const { processUpload } = await import('../src/processing.ts');
test.after(() => rm(configDir, { recursive: true, force: true }));

test(
  'isolated processing returns content, bounds concurrent admission, and cleans workspaces',
  { timeout: 10000 },
  async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('llm-processing-')));
    const first = processUpload(Buffer.from('isolated Unicode content: café'), 'text/plain', 'notes.txt');
    await assert.rejects(processUpload(Buffer.from('busy'), 'text/plain', 'other.txt'), /busy/);
    assert.match((await first).text!, /café/);
    await assert.rejects(
      processUpload(Buffer.from('<svg><script/></svg>'), 'image/svg+xml', 'bad.svg'),
      /active or external/,
    );
    const after = (await readdir(tmpdir())).filter(
      (name) => name.startsWith('llm-processing-') && !before.has(name),
    );
    assert.deepEqual(after, []);
  },
);
