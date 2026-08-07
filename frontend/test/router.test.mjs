import assert from 'node:assert/strict';
import test from 'node:test';
import { chatHref, parseHashRoute, routeHref } from '../src/lib/router.ts';

test('chat routes parse path and query parameters independently', () => {
  const route = parseHashRoute('#/chat/4debad6e-b303-4fb3-aafd-fca8e5f210f5?highlight=message-1');
  assert.equal(route.view, 'chat');
  assert.equal(route.id, '4debad6e-b303-4fb3-aafd-fca8e5f210f5');
  assert.equal(route.query.get('highlight'), 'message-1');
});

test('view-level query parameters do not become part of the view name', () => {
  const route = parseHashRoute('#/chat?auth_error=1');
  assert.equal(route.view, 'chat');
  assert.equal(route.id, null);
  assert.equal(route.query.get('auth_error'), '1');
});

test('route builders encode path and query values', () => {
  assert.equal(chatHref('conversation/id', { highlight: 'message id' }), '#/chat/conversation%2Fid?highlight=message+id');
  assert.equal(routeHref('prompts'), '#/prompts');
});

test('malformed percent escapes do not crash route parsing', () => {
  assert.doesNotThrow(() => parseHashRoute('#/chat/%E0%A4%A'));
});
