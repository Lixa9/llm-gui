import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitComposerDraft, deleteUploadBestEffort, submitComposerDraft } from '../src/lib/composerSubmission.ts';

const ready = {
  streaming: false,
  submitting: false,
  hasContent: true,
  hasReadyAttachment: false,
  hasUploadingAttachment: false,
  hasModel: true,
};

test('composer cannot send while an attachment is uploading', () => {
  assert.equal(canSubmitComposerDraft({ ...ready, hasUploadingAttachment: true }), false);
  assert.equal(canSubmitComposerDraft(ready), true);
});

test('pre-acceptance failures retain the draft', async () => {
  let cleared = false;
  const result = await submitComposerDraft(async () => ({ accepted: false }), () => { cleared = true; });
  assert.equal(result.accepted, false);
  assert.equal(cleared, false);

  await assert.rejects(
    submitComposerDraft(async () => { throw new Error('conversation creation failed'); }, () => { cleared = true; }),
    /conversation creation failed/,
  );
  assert.equal(cleared, false);
});

test('server acceptance clears the draft even if generation later reports an error', async () => {
  let cleared = false;
  const result = await submitComposerDraft(async () => ({ accepted: true }), () => { cleared = true; });
  assert.equal(result.accepted, true);
  assert.equal(cleared, true);
});

test('abandoned uploads are deleted without surfacing cleanup failures', async () => {
  const deleted = [];
  assert.equal(await deleteUploadBestEffort('upload-1', async id => { deleted.push(id); }), true);
  assert.deepEqual(deleted, ['upload-1']);
  assert.equal(await deleteUploadBestEffort('upload-2', async () => { throw new Error('already attached'); }), false);
});
