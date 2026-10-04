import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { AutomationRow } from '../src/types.ts';

const databaseUrl = process.env.GENERATION_TEST_DATABASE_URL;

test('durable background job lifecycle', { skip: !databaseUrl, timeout: 30_000 }, async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'llm-generation-test-'));
  let mode: 'complete' | 'slow' | 'idle' = 'complete';
  let nonStreamingCalls = 0;
  const streamingRequests: any[] = [];
  const upstream = createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean; messages?: Array<{ content?: string }> };
      if (payload.stream === false) {
        nonStreamingCalls += 1;
        const isTitle = payload.messages?.[0]?.content?.startsWith('Return a 4-6 word title');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: isTitle ? 'Durable generated title' : 'automation answer' } }] }));
        return;
      }
      streamingRequests.push(payload);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'complete') {
        response.end('data: {"choices":[{"delta":{"content":"new answer"}}]}\n\ndata: [DONE]\n\n');
      } else if (mode === 'slow') {
        response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      }
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address === 'object');

  await Promise.all([
    writeFile(join(configDir, 'config.yaml'), `
app:
  name: Test
  base_url: http://localhost:3000
openai:
  base_url: http://127.0.0.1:${address.port}/v1
storage:
  quota: "0"
conversation:
  auto_title: false
  generation_max_duration_ms: 5000
  generation_idle_timeout_ms: 1000
  generation_max_attempts: 3
`),
    writeFile(join(configDir, 'models.yaml'), 'models:\n  - id: test\n    display_name: Test\n    allowed_roles: [admin, user]\n'),
    writeFile(join(configDir, 'prompts.yaml'), 'prompts: []\n'),
    writeFile(join(configDir, 'presets.yaml'), 'presets: []\n'),
    writeFile(join(configDir, 'automations.yaml'), 'automations: []\n'),
  ]);
  process.env.CONFIG_DIR = configDir;
  process.env.LOCAL_AUTH = 'true';

  const { loadConfig } = await import('../src/config.ts');
  const { openDatabase, closeDatabase, getDb, generateId, runTransaction } = await import('../src/db/index.ts');
  const { runGeneration, cancelGeneration } = await import('../src/generation-worker.ts');
  const { runTitleJob } = await import('../src/title-worker.ts');
  const { enqueueAutomationRun, runAutomationJob } = await import('../src/automation-runner.ts');
  const { relayRouter } = await import('../src/relay.ts');
  const { draftsRouter } = await import('../src/drafts.ts');
  const { purgeOrphanUploads, uploadsRouter } = await import('../src/uploads.ts');
  const { resolveCurrentRole } = await import('../src/auth.ts');
  const { providerIdentity, getConfig, configurationRevision } = await import('../src/config.ts');
  const { conversationsRouter } = await import('../src/conversations.ts');
  loadConfig();
  await openDatabase(databaseUrl);
  const db = getDb();
  const owner = `integration:${generateId()}`;
  await db.prepare("INSERT INTO users (sub, email, name, last_known_role) VALUES (?, '', 'test', 'user')").run(owner);

  async function createJob(status: 'queued' | 'running' = 'queued', partial = '', autoTitle = false) {
    const conversationId = generateId();
    const userId = generateId();
    const assistantId = generateId();
    const now = Date.now();
    await db.prepare('INSERT INTO conversations (id, owner_sub) VALUES (?, ?)').run(conversationId, owner);
    await db.prepare("INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp) VALUES (?, ?, 'user', ?, 'prompt', 'done', ?)")
      .run(userId, conversationId, JSON.stringify([{ type: 'text', text: 'prompt' }]), now);
    await db.prepare("INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp) VALUES (?, ?, 'assistant', ?, ?, 'test', 'streaming', ?)")
      .run(assistantId, conversationId, JSON.stringify(partial ? [{ type: 'text', text: partial }] : []), partial, now + 1);
    await db.prepare(`
      INSERT INTO chat_generations (id, conversation_id, user_message_id, assistant_message_id, owner_sub, request_snapshot, status, attempt, lease_owner, lease_until, available_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(assistantId, conversationId, userId, assistantId, owner, JSON.stringify({
      provider: providerIdentity(), model: 'test', transport_version:2, model_entry:getConfig().models!.find(model=>model.id==='test'), input_messages: [{ role: 'user', content: 'prompt' }], title_prompt: 'prompt',
      is_first_exchange: autoTitle, auto_title: autoTitle, auto_title_model: 'test',
    }), status, status === 'running' ? 1 : 0, status === 'running' ? 'dead-worker' : null, status === 'running' ? now - 1 : null);
    return { conversationId, userId, assistantId };
  }

  try {
    const normal = await createJob();
    assert.equal(await runGeneration(normal.assistantId), true);
    assert.deepEqual(streamingRequests.at(-1),{model:'test',messages:[{role:'user',content:'prompt'}],stream:true});
    assert.deepEqual(
      await db.prepare('SELECT content_text, status FROM messages WHERE id=?').get(normal.assistantId),
      { content_text: 'new answer', status: 'done' },
    );
    const diagnosticRow = await db.prepare('SELECT diagnostics FROM chat_generations WHERE id=?')
      .get<{ diagnostics: { provider_status: number; request_bytes: number; output_bytes: number; input: { text_chars: number } } }>(normal.assistantId);
    assert.equal(diagnosticRow?.diagnostics.provider_status, 200);
    assert.ok(diagnosticRow!.diagnostics.request_bytes > 0);
    assert.equal(diagnosticRow?.diagnostics.output_bytes, Buffer.byteLength('new answer'));
    assert.doesNotMatch(JSON.stringify(diagnosticRow?.diagnostics), /"prompt"|new answer/);

    const fenced = await createJob();
    const priorActivation = await db.prepare("SELECT revision FROM runtime_configuration WHERE key='active'").get<{revision:string}>();
    const oldRevision = createHash('sha256').update(JSON.stringify(getConfig())).digest('hex');
    try {
      await db.prepare("INSERT INTO runtime_configuration (key,revision) VALUES ('active',?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision").run(oldRevision);
      assert.equal(await runGeneration(fenced.assistantId),false,'old request-contract activation must fence new workers');
      await db.prepare("UPDATE runtime_configuration SET revision=? WHERE key='active'").run(configurationRevision());
      assert.equal(await runGeneration(fenced.assistantId),true);
    } finally {
      if (priorActivation) await db.prepare("UPDATE runtime_configuration SET revision=? WHERE key='active'").run(priorActivation.revision);
      else await db.prepare("DELETE FROM runtime_configuration WHERE key='active'").run();
    }

    const legacy = await createJob();
    await db.prepare("UPDATE chat_generations SET request_snapshot=request_snapshot - 'transport_version' WHERE id=?").run(legacy.assistantId);
    const beforeLegacy = streamingRequests.length;
    await runGeneration(legacy.assistantId);
    assert.equal(streamingRequests.length, beforeLegacy, 'legacy snapshots must not send incomplete history');
    const legacyResult = await db.prepare('SELECT status,last_error FROM chat_generations WHERE id=?').get<{status:string;last_error:string}>(legacy.assistantId);
    assert.equal(legacyResult?.status,'failed');
    assert.match(legacyResult!.last_error,/Resubmit.*full history/);

    const recovered = await createJob('running', 'old partial');
    assert.equal(await runGeneration(recovered.assistantId), true);
    assert.deepEqual(
      await db.prepare('SELECT content_text, status FROM messages WHERE id=?').get(recovered.assistantId),
      { content_text: 'new answer', status: 'done' },
    );
    assert.deepEqual(
      await db.prepare('SELECT attempt, status FROM chat_generations WHERE id=?').get(recovered.assistantId),
      { attempt: 2, status: 'done' },
    );

    mode = 'slow';
    const cancelled = await createJob();
    const cancelRun = runGeneration(cancelled.assistantId);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await cancelGeneration(cancelled.assistantId, owner))?.status, 'cancelled');
    await cancelRun;
    assert.deepEqual(
      await db.prepare('SELECT content_text, status FROM messages WHERE id=?').get(cancelled.assistantId),
      { content_text: 'partial', status: 'aborted' },
    );

    const deleted = await createJob();
    const deleteRun = runGeneration(deleted.assistantId);
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.prepare('DELETE FROM messages WHERE conversation_id=? AND timestamp >= (SELECT timestamp FROM messages WHERE id=?)').run(deleted.conversationId, deleted.userId);
    await deleteRun;
    assert.equal(await db.prepare('SELECT id FROM messages WHERE id=?').get(deleted.assistantId), undefined);

    mode = 'idle';
    const timedOut = await createJob();
    await runGeneration(timedOut.assistantId);
    assert.deepEqual(
      await db.prepare('SELECT status FROM chat_generations WHERE id=?').get(timedOut.assistantId),
      { status: 'timed_out' },
    );
    assert.deepEqual(
      await db.prepare('SELECT status FROM messages WHERE id=?').get(timedOut.assistantId),
      { status: 'timed_out' },
    );

    mode = 'complete';
    const titled = await createJob('queued', '', true);
    await runGeneration(titled.assistantId);
    const titleJob = await db.prepare('SELECT id FROM conversation_title_jobs WHERE generation_id=?').get<{ id: string }>(titled.assistantId);
    assert(titleJob);
    const titleClaims = await Promise.all([runTitleJob(titleJob.id), runTitleJob(titleJob.id)]);
    assert.equal(titleClaims.filter(Boolean).length, 1);
    assert.deepEqual(
      await db.prepare('SELECT title, title_auto FROM conversations WHERE id=?').get(titled.conversationId),
      { title: 'Durable generated title', title_auto: true },
    );

    const renamed = await createJob('queued', '', true);
    await runGeneration(renamed.assistantId);
    await db.prepare("UPDATE conversations SET title='Manual title', title_auto=false WHERE id=?").run(renamed.conversationId);
    const skippedTitleJob = await db.prepare('SELECT id FROM conversation_title_jobs WHERE generation_id=?').get<{ id: string }>(renamed.assistantId);
    assert(skippedTitleJob);
    await runTitleJob(skippedTitleJob.id);
    assert.deepEqual(
      await db.prepare('SELECT title, title_auto FROM conversations WHERE id=?').get(renamed.conversationId),
      { title: 'Manual title', title_auto: false },
    );
    assert.deepEqual(
      await db.prepare('SELECT status FROM conversation_title_jobs WHERE id=?').get(skippedTitleJob.id),
      { status: 'skipped' },
    );

    const automationId = generateId();
    await db.prepare(`
      INSERT INTO automations (id, owner_sub, name, type, definition, enabled, next_run_at)
      VALUES (?, NULL, 'Durable automation', 'scheduled', ?::jsonb, true, ?)
    `).run(automationId, JSON.stringify({ interval: 1, unit: 'days', model: 'test', user_prompt: 'automate this' }), Date.now() + 86_400_000);
    await db.prepare(`
      INSERT INTO user_automation_subscriptions (user_sub, automation_id, enabled) VALUES (?, ?, true)
    `).run(owner, automationId);
    const automation = await db.prepare('SELECT * FROM automations WHERE id=?').get<any>(automationId);
    assert(automation);
    const automationRun = await runTransaction(dbTx => enqueueAutomationRun(dbTx, automation, 'scheduled'));
    await db.prepare(`
      UPDATE automation_runs SET status='running', attempt=1, lease_owner='dead-worker', lease_until=? WHERE id=?
    `).run(Date.now() - 1, automationRun.id);
    assert.equal(await runAutomationJob(automationRun.id), true);
    assert.deepEqual(
      await db.prepare('SELECT status, attempt, result_text FROM automation_runs WHERE id=?').get(automationRun.id),
      { status: 'done', attempt: 2, result_text: 'automation answer' },
    );
    assert.deepEqual(
      await db.prepare('SELECT status FROM automation_run_deliveries WHERE run_id=? AND user_sub=?').get(automationRun.id, owner),
      { status: 'done' },
    );

    const persistedRun = await runTransaction(dbTx => enqueueAutomationRun(dbTx, automation, 'scheduled'));
    await db.prepare("UPDATE automation_runs SET result_text='persisted answer' WHERE id=?").run(persistedRun.id);
    const callsBeforeRecovery = nonStreamingCalls;
    const automationClaims = await Promise.all([runAutomationJob(persistedRun.id), runAutomationJob(persistedRun.id)]);
    assert.equal(automationClaims.filter(Boolean).length, 1);
    assert.equal(nonStreamingCalls, callsBeforeRecovery);
    assert.equal(
      (await db.prepare('SELECT COUNT(*)::int AS count FROM conversations WHERE owner_sub=? AND title LIKE ?').get<{ count: number }>(owner, 'Durable automation%'))?.count,
      2,
    );
    await db.prepare('DELETE FROM automations WHERE id=?').run(automationId);

    const sourceConversationId = generateId();
    const sourceMessageId = generateId();
    await db.prepare('INSERT INTO conversations (id, owner_sub, title) VALUES (?, ?, ?)').run(sourceConversationId, owner, 'Copy source');
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp)
      VALUES (?, ?, 'user', ?, 'source prompt', 'done', ?)
    `).run(sourceMessageId, sourceConversationId, JSON.stringify([{ type: 'text', text: 'source prompt' }]), Date.now());

    const sessionToken = `integration-session-${generateId()}-${generateId()}`;
    await db.prepare(`
      INSERT INTO sessions (id, token_hash, sub, email, name, role, method, expires_at)
      VALUES (?, ?, ?, '', 'test', 'user', 'local', ?)
    `).run(generateId(), createHash('sha256').update(sessionToken).digest('hex'), owner, Date.now() + 60_000);
    const conversationApp = new Hono();
    conversationApp.route('/api/conversations', conversationsRouter);

    let releaseConversationLock!: () => void;
    let reportConversationLock!: () => void;
    const conversationLockHeld = new Promise<void>(resolve => { reportConversationLock = resolve; });
    const releaseConversation = new Promise<void>(resolve => { releaseConversationLock = resolve; });
    const blocker = runTransaction(async tx => {
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(sourceConversationId);
      reportConversationLock();
      await releaseConversation;
    });
    await conversationLockHeld;

    const duplicateRequest = conversationApp.request(`/api/conversations/${sourceConversationId}/duplicate`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}` },
    });
    const lockWaitDeadline = Date.now() + 2_000;
    while (true) {
      const waitingLock = await db.prepare(`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        ) AS waiting
      `).get<{ waiting: boolean }>();
      if (waitingLock?.waiting) break;
      assert(Date.now() < lockWaitDeadline, 'duplicate request did not wait for the conversation lock');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    releaseConversationLock();
    await blocker;
    const duplicateResponse = await duplicateRequest;
    assert.equal(duplicateResponse.status, 201, await duplicateResponse.clone().text());
    const duplicate = await duplicateResponse.json() as { id: string };
    assert.equal(
      (await db.prepare("SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=? AND status='streaming'").get<{ count: number }>(duplicate.id))?.count,
      0,
    );

    await runTransaction(async tx => {
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(sourceConversationId);
      const promptId = generateId();
      const assistantId = generateId();
      const timestamp = Date.now();
      await tx.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, content_text, status, timestamp)
        VALUES (?, ?, 'user', ?, 'concurrent prompt', 'done', ?)
      `).run(promptId, sourceConversationId, JSON.stringify([{ type: 'text', text: 'concurrent prompt' }]), timestamp);
      await tx.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, content_text, model, status, timestamp)
        VALUES (?, ?, 'assistant', '[]', '', 'test', 'streaming', ?)
      `).run(assistantId, sourceConversationId, timestamp + 1);
      await tx.prepare(`
        INSERT INTO chat_generations
          (id, conversation_id, user_message_id, assistant_message_id, owner_sub, request_snapshot, status, available_at)
        VALUES (?, ?, ?, ?, ?, '{}'::jsonb, 'queued', ?)
      `).run(assistantId, sourceConversationId, promptId, assistantId, owner, Date.now());
    });

    const blockedDuplicateResponse = await conversationApp.request(`/api/conversations/${sourceConversationId}/duplicate`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}` },
    });
    assert.equal(blockedDuplicateResponse.status, 409, await blockedDuplicateResponse.clone().text());

    const forkResponse = await conversationApp.request(`/api/conversations/${sourceConversationId}/fork`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: sourceMessageId }),
    });
    assert.equal(forkResponse.status, 409, await forkResponse.clone().text());
    // Attachment edits and snapshots use one acceptance transaction.
    const app=new Hono();app.route('/api/chat',relayRouter);app.route('/api/drafts',draftsRouter);app.route('/api/conversations',conversationsRouter);app.route('/api/uploads',uploadsRouter);
    const headers={cookie:`session=${sessionToken}`,'content-type':'application/json'};
    const corruptOffice = new FormData();
    corruptOffice.set('file', new File(['not an Office document'], 'broken.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    const corruptResponse = await app.request('/api/uploads', {
      method: 'POST', headers: { cookie: `session=${sessionToken}` }, body: corruptOffice,
    });
    assert.equal(corruptResponse.status, 422, await corruptResponse.clone().text());
    assert.equal(await db.prepare("SELECT id FROM uploads WHERE owner_sub=? AND filename='broken.docx'").get(owner), undefined);
    const attachedConversation=generateId(),attachedUser=generateId(),oldAssistant=generateId(),upload=generateId();
    await db.prepare("INSERT INTO conversations (id,owner_sub,model_id,custom_system_prompt) VALUES (?,?,'test','Keep the original instructions')").run(attachedConversation,owner);
    await db.prepare("INSERT INTO uploads (id,owner_sub,sha256,filename,mime_type,size,extracted_text,file_meta,data,derived_images,created_at) VALUES (?,?,'hash','notes.txt','text/plain',5,'Document body',?::jsonb,?,'[]'::jsonb,0)").run(upload,owner,JSON.stringify({processing_status:'ready',warning:'Coverage warning'}),Buffer.from('hello'));
    await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,status,timestamp) VALUES (?,?,'user',?,'Original text','done',1)").run(attachedUser,attachedConversation,JSON.stringify([{type:'text',text:'Original text'},{type:'file',file:{url:`/api/uploads/${upload}`}}]));
    await db.prepare("INSERT INTO message_uploads (message_id,upload_id) VALUES (?,?)").run(attachedUser,upload);
    await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,status,timestamp) VALUES (?,?,'assistant','[]','Old answer','done',2)").run(oldAssistant,attachedConversation);
    const noEdit=await app.request(`/api/conversations/${attachedConversation}/messages/${attachedUser}`,{method:'PATCH',headers,body:JSON.stringify({content:'Patched text'})});
    assert.equal(noEdit.status,200);
    assert.equal((await noEdit.json() as {content:unknown[]}).content.length,2,'PATCH must preserve attachments');
    const rejected=await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'test',edit_message_id:attachedUser,new_user_message:{content:[{type:'text',text:'x'.repeat(600000)}]}})});
    assert.equal(rejected.status,400,'aggregate context budget must reject the edit');
    assert.ok(await db.prepare('SELECT id FROM messages WHERE id=?').get(oldAssistant),'failed edit must keep later history');
    assert.equal((await db.prepare('SELECT content_text FROM messages WHERE id=?').get<{content_text:string}>(attachedUser))?.content_text,'Patched text');
    const edited=await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'test',edit_message_id:attachedUser,new_user_message:{content:[{type:'text',text:'Edited text'}]}})});
    assert.equal(edited.status,200,await edited.clone().text());
    const body=await edited.text();assert.match(body,/accepted/);
    const updated=await db.prepare('SELECT content FROM messages WHERE id=?').get<{content:Array<{type:string}>}>(attachedUser);
    assert.equal(JSON.parse(String(updated?.content)).length,2);assert.ok(await db.prepare('SELECT id FROM uploads WHERE id=?').get(upload));
    assert.equal(await db.prepare('SELECT id FROM messages WHERE id=?').get(oldAssistant),undefined);
    assert.equal((await db.prepare("SELECT count(*)::int AS count FROM generation_uploads gu JOIN chat_generations g ON g.id=gu.generation_id WHERE g.conversation_id=?").get<{count:number}>(attachedConversation))?.count,0,'finished generations release asset pins');

    const editedWire = streamingRequests.at(-1);
    assert.deepEqual(editedWire.messages,[
      {role:'system',content:'Keep the original instructions'},
      {role:'user',content:[
        {type:'text',text:'Edited text'},
        {type:'text',text:'Attachment: "notes.txt"\nNotice: "Coverage warning"\n\nDocument body'},
      ]},
    ]);
    assert.equal('session_id' in editedWire,false);
    const editedAssistant = await db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='assistant'").get<{id:string}>(attachedConversation);
    const regeneration = await app.request('/api/chat/regenerate',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,assistant_message_id:editedAssistant!.id,model:'test'})});
    assert.equal(regeneration.status,200);await regeneration.text();
    assert.deepEqual(streamingRequests.at(-1).messages,editedWire.messages,'regeneration must preserve files and omit the replaced answer');
    const followup = await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'test',new_user_message:{content:[{type:'text',text:'What next?'}]}})});
    assert.equal(followup.status,200);await followup.text();
    assert.deepEqual(streamingRequests.at(-1).messages,[...editedWire.messages,{role:'assistant',content:'new answer'},{role:'user',content:'What next?'}]);
    const partialId=generateId();
    await db.prepare("INSERT INTO messages (id,conversation_id,role,content,content_text,status,timestamp) VALUES (?,?,'assistant',?,'unfinished','aborted',?)").run(partialId,attachedConversation,JSON.stringify([{type:'text',text:'unfinished'}]),Date.now()+1);
    const afterPartial = await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'test',new_user_message:{content:[{type:'text',text:'Continue without the interrupted answer'}]}})});
    assert.equal(afterPartial.status,200);await afterPartial.text();
    assert.doesNotMatch(JSON.stringify(streamingRequests.at(-1)),/unfinished/);
    assert.ok(await db.prepare('SELECT id FROM messages WHERE id=?').get(partialId),'interrupted output remains stored');

    const newFile = new FormData();
    const sourceText = '  indented source\nAttachment: "payload heading"\n';
    newFile.append('file',new File([sourceText],'fresh.txt',{type:'text/plain'}));
    const uploaded = await app.request('/api/uploads',{method:'POST',headers:{cookie:`session=${sessionToken}`},body:newFile});
    assert.equal(uploaded.status,201,await uploaded.clone().text());
    const fresh = await uploaded.json() as {id:string;url:string};
    assert.doesNotMatch(JSON.stringify(fresh),/content_blocks|indented source/);
    const freshMetadata = await app.request(`/api/uploads/${fresh.id}/metadata`,{headers});
    assert.equal(freshMetadata.status,200);assert.doesNotMatch(await freshMetadata.text(),/content_blocks|indented source/);
    await app.request('/api/drafts/new',{method:'PUT',headers,body:JSON.stringify({text:'',attachments:[{id:fresh.id}]})});
    const freshDraft = await app.request('/api/drafts/new',{headers});
    assert.doesNotMatch(await freshDraft.text(),/content_blocks|indented source/);
    await app.request('/api/drafts/new',{method:'PUT',headers,body:JSON.stringify({text:'',attachments:[]})});
    const attachmentOnly = await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({model:'test',new_user_message:{content:[{type:'file',file:{url:fresh.url}}]}})});
    assert.equal(attachmentOnly.status,200);await attachmentOnly.text();
    assert.deepEqual(streamingRequests.at(-1),{model:'test',stream:true,messages:[{role:'user',content:[{type:'text',text:''},{type:'text',text:`Attachment: "fresh.txt"\n\n${sourceText}`}]}]});

    // An accepted, queued job stores IDs rather than base64/expanded documents.
    mode='slow';
    const firstBusy=await createJob(),secondBusy=await createJob();
    const busyA=runGeneration(firstBusy.assistantId),busyB=runGeneration(secondBusy.assistantId);
    await new Promise(resolve=>setTimeout(resolve,50));
    const queued=await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'test',new_user_message:{content:[{type:'text',text:'Continue'},{type:'file',file:{url:`/api/uploads/${upload}`}}]}})});
    assert.equal(queued.status,200);const acceptedEvents=await queued.text();assert.match(acceptedEvents,/accepted/);
    const queueRow=await db.prepare("SELECT id,request_snapshot FROM chat_generations WHERE conversation_id=? AND status='queued'").get<{id:string;request_snapshot:{input_messages:Array<{role:string;content:unknown}>;openai_messages?:unknown}}>(attachedConversation);
    assert.ok(queueRow);assert.equal(queueRow.request_snapshot.openai_messages,undefined);assert.match(JSON.stringify(queueRow.request_snapshot),/Keep the original instructions/);assert.doesNotMatch(JSON.stringify(queueRow.request_snapshot),/Document body/);
    assert.ok(await db.prepare('SELECT upload_id FROM generation_uploads WHERE generation_id=?').get(queueRow.id));
    await cancelGeneration(queueRow.id,owner);assert.equal(await db.prepare('SELECT upload_id FROM generation_uploads WHERE generation_id=?').get(queueRow.id),undefined);
    await cancelGeneration(firstBusy.assistantId,owner);await cancelGeneration(secondBusy.assistantId,owner);await Promise.all([busyA,busyB]);mode='complete';

    // Drafts pin unattached uploads and remain private to their owner.
    const draftUpload=generateId();
    await db.prepare("INSERT INTO uploads (id,owner_sub,sha256,filename,mime_type,size,data,created_at) VALUES (?,?,'hash','draft.txt','text/plain',4,?,0)").run(draftUpload,owner,Buffer.from('text'));
    await db.prepare("UPDATE uploads SET file_meta='{\"warning\":null}'::jsonb WHERE id=?").run(draftUpload);
    const savedDraft=await app.request('/api/drafts/new',{method:'PUT',headers,body:JSON.stringify({text:'Unsent text',attachments:[{id:draftUpload}]})});assert.equal(savedDraft.status,204);
    await purgeOrphanUploads();assert.ok(await db.prepare('SELECT id FROM uploads WHERE id=?').get(draftUpload));
    const recoveredDraft=await app.request('/api/drafts/new',{headers});const restored=await recoveredDraft.json() as {text:string;attachments:Array<{warning?:string}>};assert.equal(restored.text,'Unsent text');assert.equal(restored.attachments[0].warning,undefined);
    await app.request('/api/drafts/new',{method:'PUT',headers,body:JSON.stringify({text:'',attachments:[]})});await purgeOrphanUploads();assert.equal(await db.prepare('SELECT id FROM uploads WHERE id=?').get(draftUpload),undefined);

    // Existing sessions read the user's current role instead of their login role.
    await db.prepare("UPDATE users SET last_known_role='admin' WHERE sub=?").run(owner);assert.equal(await resolveCurrentRole(owner),'admin');
    await db.prepare("UPDATE users SET last_known_role='user' WHERE sub=?").run(owner);assert.equal(await resolveCurrentRole(owner),'user');
    const oldRole=await app.request('/api/chat',{method:'POST',headers,body:JSON.stringify({conversation_id:attachedConversation,model:'missing-model',new_user_message:{content:[{type:'text',text:'hello'}]}})});assert.equal(oldRole.status,400);

    // Provider changes are deterministic errors and never reroute or retry.
    const pinned=await createJob();
    await db.prepare("UPDATE chat_generations SET request_snapshot=jsonb_set(request_snapshot,'{provider}',?::jsonb) WHERE id=?").run(JSON.stringify({...providerIdentity(),revision:'previous-provider'}),pinned.assistantId);
    await runGeneration(pinned.assistantId);assert.equal((await db.prepare('SELECT status FROM chat_generations WHERE id=?').get<{status:string}>(pinned.assistantId))?.status,'failed');

    // Current subscription and role determine delivery eligibility.
    const sharedId=generateId();
    await db.prepare("INSERT INTO automations (id,owner_sub,name,type,definition,enabled,visible_to) VALUES (?,NULL,'Shared','scheduled',?::jsonb,true,?::jsonb)").run(sharedId,JSON.stringify({interval:1,unit:'days',model:'test',system_prompt:'Persisted instructions',user_prompt:'Scheduled prompt'}),JSON.stringify(['user']));
    await db.prepare('INSERT INTO user_automation_subscriptions (user_sub,automation_id,enabled) VALUES (?,?,true)').run(owner,sharedId);
    const shared=(await db.prepare('SELECT * FROM automations WHERE id=?').get<AutomationRow>(sharedId))!;
    const sharedRun=await runTransaction(tx=>enqueueAutomationRun(tx,shared,'scheduled'));
    await db.prepare('UPDATE user_automation_subscriptions SET enabled=false WHERE user_sub=? AND automation_id=?').run(owner,sharedId);
    await runAutomationJob(sharedRun.id);
    assert.equal((await db.prepare('SELECT status FROM automation_run_deliveries WHERE run_id=? AND user_sub=?').get<{status:string}>(sharedRun.id,owner))?.status,'skipped');
    await db.prepare('DELETE FROM automations WHERE id=?').run(sharedId);

  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await db.prepare('DELETE FROM users WHERE sub=?').run(owner);
    await closeDatabase();
    await rm(configDir, { recursive: true, force: true });
  }
});
