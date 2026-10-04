import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageRow, ModelYamlEntry } from '../src/types.ts';
import type { TxDb } from '../src/db/index.ts';

const configDir = await mkdtemp(join(tmpdir(), 'llm-conversation-test-'));
process.env.CONFIG_DIR = configDir;
await writeFile(join(configDir, 'config.yaml'), 'app:\n  name: Test\n');
for (const key of ['models', 'prompts', 'presets', 'automations'])
  await writeFile(join(configDir, `${key}.yaml`), `${key}: []\n`);
const { loadConfig } = await import('../src/config.ts');
loadConfig();
test.after(() => rm(configDir, { recursive: true, force: true }));
const { resolveMessageContent, attachmentText } = await import('../src/attachment-transport.ts');
const { buildOpenaiMessages } = await import('../src/relay.ts');
const { textPrefix, limitBlocks } = await import('../src/content-blocks.ts');

const model: ModelYamlEntry = {
  id: 'test', display_name: 'Test', allowed_roles: ['user'],
  capabilities: { vision: true, native_pdf: false, image_detail: 'auto' },
};
const url = '/api/uploads/12345678-1234-1234-1234-123456789abc';
function database(row?: Record<string, unknown>): TxDb {
  return { prepare: () => ({ get: async () => row }) } as unknown as TxDb;
}
function message(role: 'user' | 'assistant', text: string, status = 'done'): MessageRow {
  return { role, content: JSON.stringify([{type:'text',text}]), content_text: text, status } as MessageRow;
}

test('ordinary user and assistant text passes through unchanged, even if it looks like metadata', async () => {
  const text = '  Attachment: "notes.txt"\n\n{"filename":"x","content":"y"}\n```py\nx = 1\n```\n';
  const db = { prepare: () => assert.fail('plain text must not resolve uploads') } as unknown as TxDb;
  assert.equal(await resolveMessageContent([{type:'text',text}], 'owner', model, db), text);
  assert.equal(await resolveMessageContent([{type:'text',text}], 'owner', model, db, 'assistant'), text);
});

test('full replay retains accepted turns, excludes interrupted answers, and injects no default prompt', async () => {
  const history = [
    {...message('user', 'First question'),status:null}, message('assistant', 'Answer'),
    message('user', 'Second question'), message('assistant', 'Interrupted output', 'aborted'),
  ];
  const snapshot = await buildOpenaiMessages(history, [{type:'text',text:'Continue'}], '', model, 'owner', database());
  assert.deepEqual(snapshot, [
    {role:'user',content:[{type:'text',text:'First question'}]},
    {role:'assistant',content:[{type:'text',text:'Answer'}]},
    {role:'user',content:[{type:'text',text:'Second question'}]},
    {role:'user',content:[{type:'text',text:'Continue'}]},
  ]);
  const withPrompt = await buildOpenaiMessages([], [{type:'text',text:'Hello'}], 'Configured prompt', model, 'owner', database());
  assert.deepEqual(withPrompt[0], {role:'system',content:'Configured prompt'});
});

test('attachment-only messages have an empty user text part and quoted, parseable headers', async () => {
  const filename = 'weird"\nPart: injected.txt';
  const payload = 'Attachment: "payload.txt"\n\nKeep this exactly.\n';
  const row = {
    filename, mime_type:'text/plain', data:Buffer.from(payload), extracted_text:payload,
    file_meta:{processing_version:2,content_blocks:[{type:'text',text:payload}]}, derived_images:[],
  };
  const result = await resolveMessageContent([{type:'file',file:{url},_filename:'spoof'}], 'owner', model, database(row));
  assert.deepEqual(result, [{type:'text',text:''},{type:'text',text:attachmentText(filename,payload)}]);
  const header = (result as Array<{text:string}>)[1].text.split('\n\n')[0];
  assert.equal(JSON.parse(header.slice('Attachment: '.length)), filename);
  assert.equal(header.split('\n').length, 1);
});

test('page text immediately precedes its image, while internal metadata never goes upstream', async () => {
  const row = {
    filename:'report.pdf',mime_type:'application/pdf',data:Buffer.from('%PDF'),extracted_text:'Flattened legacy text',
    file_meta:{processing_version:2,warning:'Only page 1 is included.',private_hash:'secret',content_blocks:[
      {type:'text',part:'Page 1',text:'Actual page text'},
      {type:'image',part:'Page 1',image_index:0},
    ]},
    derived_images:[{data:'AAAA',ext:'.jpg'}],
  };
  const result = await resolveMessageContent([{type:'text',text:'Read this'},{type:'file',file:{url}}], 'owner', model, database(row));
  assert.deepEqual(result, [
    {type:'text',text:'Read this'},
    {type:'text',text:'Attachment: "report.pdf"\nPart: "Page 1"\nNotice: "Only page 1 is included."\n\nActual page text'},
    {type:'image_url',image_url:{url:'data:image/jpeg;base64,AAAA',detail:'auto'}},
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private_hash|processing_version|content_blocks|Flattened legacy/);
  await assert.rejects(resolveMessageContent([{type:'file',file:{url}}], 'owner',
    {...model,capabilities:{vision:false,native_pdf:false,image_detail:'auto'}}, database(row)), /vision model/);
  row.file_meta.content_blocks[1].image_index = 3;
  await assert.rejects(resolveMessageContent([{type:'file',file:{url}}], 'owner', model, database(row)), /inconsistent image/);
});

test('legacy extracted uploads and empty text files remain usable without JSON wrappers or invented text', async () => {
  for (const text of ['Legacy content\n', '']) {
    const row = {filename:'old.txt',mime_type:'text/plain',data:Buffer.from(text),extracted_text:text,file_meta:{},derived_images:[]};
    assert.deepEqual(await resolveMessageContent([{type:'file',file:{url}}], 'owner', model, database(row)), [
      {type:'text',text:''},{type:'text',text:`Attachment: "old.txt"\n\n${text}`},
    ]);
  }
});

test('CSV and JSONL limits keep complete records, and text limits preserve Unicode characters', () => {
  const csv = 'a,b\n"a multi\nline cell",value\nlast,row';
  assert.equal(textPrefix(csv, 14, 'csv'), 'a,b\n');
  assert.equal(textPrefix('{"a":1}\n{"b":2}', 10, 'jsonl'), '{"a":1}\n');
  assert.equal(textPrefix('a😀b', 2), 'a');
  const result = limitBlocks([{type:'text',text:csv,format:'csv'}], 14);
  assert.equal(result.truncated, true);
  assert.equal(result.blocks[0].type === 'text' && result.blocks[0].text, 'a,b\n');
});
