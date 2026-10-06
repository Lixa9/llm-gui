import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTitleRequest, DEFAULT_AUTO_TITLE_PROMPT, type TitleRequestSnapshot } from '../src/title-request.ts';

const snapshot: TitleRequestSnapshot = {
  model: 'explicit-title-model',
  system_prompt: 'Erstelle einen kurzen deutschen Titel. Gib nur den Titel aus.',
  title_prompt: 'Wie funktioniert PostgreSQL?',
  assistant_response: 'PostgreSQL ist eine relationale Datenbank.',
};

test('title requests use the snapshotted model and custom system prompt', () => {
  assert.deepEqual(buildTitleRequest(snapshot), {
    model: 'explicit-title-model',
    stream: false,
    max_tokens: 20,
    messages: [
      { role: 'system', content: snapshot.system_prompt },
      { role: 'user', content: `${snapshot.title_prompt}\n\n${snapshot.assistant_response}` },
    ],
  });
});

test('legacy title jobs retain the previous default prompt', () => {
  const { system_prompt: omittedPrompt, ...legacySnapshot } = snapshot;
  assert.ok(omittedPrompt);
  assert.equal(buildTitleRequest(legacySnapshot).messages[0].content, DEFAULT_AUTO_TITLE_PROMPT);
  assert.equal(buildTitleRequest(legacySnapshot).model, snapshot.model);
});

test('missing or empty models fail without an implicit model fallback', () => {
  for (const model of [undefined, '', '   ']) {
    assert.throws(() => buildTitleRequest({ ...snapshot, model }), /Auto-title requires an explicit model.*auto_title_model/);
  }
});

test('explicit empty prompts are errors rather than defaults', () => {
  for (const systemPrompt of ['', '   ']) {
    assert.throws(() => buildTitleRequest({ ...snapshot, system_prompt: systemPrompt }), /nonempty conversation.auto_title_prompt/);
  }
});

test('title context remains bounded independently of the configured system prompt', () => {
  const request = buildTitleRequest({ ...snapshot, title_prompt: 'x'.repeat(3000) });
  assert.equal(request.messages[1].content.length, 2000);
  assert.equal(request.messages[0].content, snapshot.system_prompt);
  for (const incompleteSnapshot of [{ ...snapshot, title_prompt: '' }, { ...snapshot, assistant_response: '' }]) {
    assert.throws(() => buildTitleRequest(incompleteSnapshot), /Invalid title job snapshot/);
  }
});
