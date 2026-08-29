import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

const databaseUrl = process.env.GENERATION_TEST_DATABASE_URL;

test('durable background job lifecycle', { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'llm-generation-test-'));
  let mode: 'complete' | 'slow' | 'idle' = 'complete';
  let nonStreamingCalls = 0;
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

  const { loadConfig } = await import('../src/config');
  const { openDatabase, closeDatabase, getDb, generateId, runTransaction } = await import('../src/db/index');
  const { runGeneration, cancelGeneration } = await import('../src/generation-worker');
  const { runTitleJob } = await import('../src/title-worker');
  const { enqueueAutomationRun, runAutomationJob } = await import('../src/automation-runner');
  const { conversationsRouter } = await import('../src/conversations');
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
      model: 'test', openai_messages: [{ role: 'user', content: 'prompt' }], title_prompt: 'prompt',
      is_first_exchange: autoTitle, auto_title: autoTitle, auto_title_model: 'test',
    }), status, status === 'running' ? 1 : 0, status === 'running' ? 'dead-worker' : null, status === 'running' ? now - 1 : null);
    return { conversationId, userId, assistantId };
  }

  try {
    const normal = await createJob();
    assert.equal(await runGeneration(normal.assistantId), true);
    assert.deepEqual(
      await db.prepare('SELECT content_text, status FROM messages WHERE id=?').get(normal.assistantId),
      { content_text: 'new answer', status: 'done' },
    );

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

    const admission = runTransaction(async tx => {
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
    await new Promise(resolve => setTimeout(resolve, 25));
    const duplicateRequest = conversationApp.request(`/api/conversations/${sourceConversationId}/duplicate`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}` },
    });
    releaseConversationLock();
    await blocker;
    await admission;
    const duplicateResponse = await duplicateRequest;
    assert([201, 409].includes(duplicateResponse.status));
    if (duplicateResponse.status === 201) {
      const duplicate = await duplicateResponse.json() as { id: string };
      assert.equal(
        (await db.prepare("SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=? AND status='streaming'").get<{ count: number }>(duplicate.id))?.count,
        0,
      );
    }

    const forkResponse = await conversationApp.request(`/api/conversations/${sourceConversationId}/fork`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: sourceMessageId }),
    });
    assert.equal(forkResponse.status, 409);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await db.prepare('DELETE FROM users WHERE sub=?').run(owner);
    await closeDatabase();
    await rm(configDir, { recursive: true, force: true });
  }
});
