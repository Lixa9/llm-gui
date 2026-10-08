import assert from 'node:assert/strict';
import test from 'node:test';
import { api, HttpError } from '../src/lib/api.ts';

for (const kind of ['json', 'upload']) {
  const request = () => kind === 'upload'
    ? api.uploads.upload(new File(['hello'], 'hello.txt', { type: 'text/plain' }))
    : api.auth.me();

  test(`${kind} requests parse successful JSON responses`, async context => {
    context.mock.method(globalThis, 'fetch', async (_path, options) => {
      assert.equal(options.headers['X-Requested-With'], 'llm-frontend');
      assert.equal(options.credentials, 'same-origin');
      if (kind === 'upload') {
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('file').name, 'hello.txt');
        assert.equal(options.body.has('model'), false);
        assert.equal(options.headers['Content-Type'], undefined);
      }
      return new Response(JSON.stringify({ id: 'saved' }), { status: 201 });
    });
    assert.deepEqual(await request(), { id: 'saved' });
  });

  test(`${kind} requests retain structured HTTP errors`, async context => {
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 507 }));
    await assert.rejects(request(), error => error instanceof HttpError && error.status === 507 && error.message === 'quota exceeded');
  });

  test(`${kind} requests fall back to status text for non-JSON errors`, async context => {
    context.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }));
    await assert.rejects(request(), error => error instanceof HttpError && error.status === 503 && error.message === 'Service Unavailable');
  });
}

test('JSON requests accept empty 204 responses', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await api.auth.logout(), undefined);
});
