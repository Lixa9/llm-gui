import { test, expect } from '@playwright/test';

const rawUser = 'Please explain **Markdown**.\nKeep this line. Ä 👋';
const rawAssistant = '# Heading\n\n**Bold** and `code`.\n\n```js\nconst x = 1;\n```';

async function mockChat(page) {
  const now = Date.now();
  const conversations = ['chat-1', 'chat-2'].map((id, index) => ({
    id, title: `Chat ${index + 1}`, owner_sub: 'test', model_id: 'mock', folder_id: null, created_at: now + index,
  }));
  const attachment = { type: 'file', file: { url: '/fixtures/report.txt' }, _filename: 'report.txt' };
  const messages = Object.fromEntries(conversations.map(conv => [conv.id, ['user', 'assistant'].map((role, index) => ({
    id: `${conv.id}-${role}`, conversation_id: conv.id, role, status: 'done',
    content: [{ type: 'text', text: role === 'user' ? rawUser : rawAssistant }, ...(role === 'user' ? [attachment] : [])],
    model: role === 'assistant' ? 'mock' : null, timestamp: now + index,
  }))]));
  const drafts = { 'chat-1': {}, 'chat-2': {} };
  const state = { drafts, messages, writes: [], patches: [], chatRequests: [], folderCreates: [], unexpected: [], rejectEdits: false, holdDraft: null, holdPatch: null };
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    let match;
    if ((match = path.match(/^\/api\/conversations\/(chat-\d)\/message-drafts(?:\/([^/]+))?$/))) {
      const [, convId, msgId] = match;
      if (method === 'GET') return route.fulfill({ json: drafts[convId] });
      if (method === 'PUT') {
        const { text } = request.postDataJSON();
        state.writes.push({ method, convId, msgId, text });
        if (state.holdDraft) await state.holdDraft;
        drafts[convId][msgId] = text;
      } else if (method === 'DELETE') {
        state.writes.push({ method, convId, msgId });
        delete drafts[convId][msgId];
      }
      return route.fulfill({ status: 204 });
    }
    if ((match = path.match(/^\/api\/conversations\/(chat-\d)\/messages(?:\/([^/]+))?$/))) {
      const [, convId, msgId] = match;
      if (method === 'GET') return route.fulfill({ json: messages[convId] });
      if (method === 'PATCH') {
        state.patches.push({ convId, msgId, ...request.postDataJSON() });
        if (state.rejectEdits) return route.fulfill({ status: 409, json: { error: 'Cannot edit now' } });
        if (state.holdPatch) await state.holdPatch;
        const message = messages[convId].find(item => item.id === msgId);
        message.content = [{ type: 'text', text: request.postDataJSON().content }, ...message.content.filter(part => part.type !== 'text')];
        message.edited_at = Date.now();
        return route.fulfill({ json: message });
      }
    }
    if (path === '/api/chat' && method === 'POST') {
      const payload = request.postDataJSON();
      state.chatRequests.push(payload);
      if (state.rejectEdits) return route.fulfill({ status: 429, json: { error: 'Rate limited' } });
      const convId = payload.conversation_id;
      const user = messages[convId].find(item => item.id === payload.edit_message_id);
      user.content = [...payload.new_user_message.content, ...user.content.filter(part => part.type !== 'text')];
      const assistant = { ...messages[convId][1], id: payload.assistant_message_id, content: [{ type: 'text', text: 'Regenerated answer' }] };
      messages[convId] = [user, assistant];
      return route.fulfill({ contentType: 'text/event-stream', body: [
        { type: 'accepted', conversation_id: convId, assistant_message_id: assistant.id, user_message: user },
        { type: 'done', message: assistant },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    let data;
    if (path === '/api/auth/me') data = { sub: 'test', name: 'Test', email: 'test@example.test', role: 'user' };
    else if (path === '/api/auth/local-enabled') data = { enabled: false };
    else if (path === '/api/app') data = { name: 'Chat', tagline: '' };
    else if (path === '/api/preferences') data = { theme: 'light', default_model_id: 'mock' };
    else if (path === '/api/conversations') data = conversations;
    else if (path === '/api/models') data = [{ id: 'mock', display_name: 'Test model' }];
    else if (path === '/api/presets' || path === '/api/prompts') data = [];
    else if (path === '/api/folders') {
      if (method === 'POST') {
        const folder = { id: 'folder-1', name: request.postDataJSON().name, parent_id: null, owner_sub: 'test', created_at: now };
        state.folderCreates.push(folder);
        return route.fulfill({ json: folder });
      }
      data = [];
    }
    else if (path === '/api/uploads/formats') data = [];
    else if (path.startsWith('/api/drafts/')) data = { text: '', attachments: [] };
    else if ((match = path.match(/^\/api\/conversations\/(chat-\d)$/))) data = conversations.find(conv => conv.id === match[1]);
    else {
      state.unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected request' } });
    }
    return route.fulfill({ json: data });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/chat/chat-1');
  await expect(page.locator('.msg-wrapper')).toHaveCount(2);
  return { ...state, state, errors };
}

function message(page, role) { return page.locator(`.msg-${role}`).first(); }
async function edit(page, role) {
  await message(page, role).getByRole('button', { name: 'Edit', exact: true }).click();
  return message(page, role).locator('.edit-area');
}
async function switchChat(page, title) {
  await page.locator('.conv-title').filter({ hasText: title }).click();
  await expect(page.locator('.msg-wrapper')).toHaveCount(2);
}

test('new folder dismisses outside, stays open inside, and still submits with Enter', async ({ page }) => {
  const app = await mockChat(page);
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const field = page.locator('.new-folder-input');
  await field.fill('Discard me');
  await field.click();
  await expect(field).toBeVisible();
  await page.locator('.chat-toolbar').click({ position: { x: 10, y: 10 } });
  await expect(field).toHaveCount(0);
  expect(app.folderCreates).toEqual([]);
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(field).toHaveValue('');
  await field.fill('Keep me');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(() => app.folderCreates.map(folder => folder.name)).toEqual(['Keep me']);
  expect(app.errors).toEqual([]);
});

test('both roles edit raw text in place, retain separate drafts across chats, tabs and reload, and cancel without changing messages', async ({ page }) => {
  const app = await mockChat(page);
  for (const [role, raw] of [['user', rawUser], ['assistant', rawAssistant]]) {
    const field = await edit(page, role);
    await expect(field).toHaveValue(raw);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await field.fill(`Draft ${role}\n**raw** 👋`);
  }
  await expect(message(page, 'user').getByRole('link', { name: /report.txt/ })).toBeVisible();
  await switchChat(page, 'Chat 2');
  await expect(page.locator('.edit-area')).toHaveCount(0);
  await switchChat(page, 'Chat 1');
  await expect(message(page, 'user').locator('.edit-area')).toHaveValue('Draft user\n**raw** 👋');
  await expect(message(page, 'assistant').locator('.edit-area')).toHaveValue('Draft assistant\n**raw** 👋');
  await page.locator('.nav').getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.locator('.nav').getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.edit-area')).toHaveCount(2);
  await expect.poll(() => Object.keys(app.drafts['chat-1']).length).toBe(2);
  await page.reload();
  await expect(message(page, 'assistant').locator('.edit-area')).toHaveValue('Draft assistant\n**raw** 👋');
  for (const role of ['user', 'assistant']) {
    await message(page, role).getByRole('button', { name: 'Cancel editing', exact: true }).click();
  }
  await expect(page.locator('.edit-area')).toHaveCount(0);
  await expect.poll(() => app.drafts['chat-1']).toEqual({});
  await expect(message(page, 'assistant').getByRole('heading', { name: 'Heading' })).toBeVisible();
  expect(app.patches).toEqual([]);
  expect(app.chatRequests).toEqual([]);
  await page.reload();
  await expect(page.locator('.msg-wrapper')).toHaveCount(2);
  await expect(page.locator('.edit-area')).toHaveCount(0);
  expect(app.unexpected).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('cancelling an empty draft after an in-flight save does not resurrect it', async ({ page }) => {
  const app = await mockChat(page);
  let release;
  app.state.holdDraft = new Promise(resolve => { release = resolve; });
  const field = await edit(page, 'assistant');
  await field.fill('');
  await expect(message(page, 'assistant').getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expect.poll(() => app.writes.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  release();
  await expect.poll(() => app.writes.map(write => write.method)).toEqual(['PUT', 'DELETE']);
  await expect.poll(() => app.drafts['chat-1']).toEqual({});
  await page.reload();
  await expect(page.locator('.msg-wrapper')).toHaveCount(2);
  await expect(page.locator('.edit-area')).toHaveCount(0);
});

test('assistant save keeps a rejected edit and only clears its draft after successful saving', async ({ page }) => {
  const app = await mockChat(page);
  const field = await edit(page, 'assistant');
  await field.fill('  ## Edited\n\nKeep trailing whitespace.  ');
  app.state.rejectEdits = true;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('  ## Edited\n\nKeep trailing whitespace.  ');
  app.state.rejectEdits = false;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(message(page, 'assistant').getByRole('heading', { name: 'Edited' })).toBeVisible();
  await expect.poll(() => app.drafts['chat-1']).toEqual({});
  expect(app.chatRequests).toEqual([]);
  expect(app.messages['chat-1'][1].content[0].text).toBe('  ## Edited\n\nKeep trailing whitespace.  ');
  expect(app.errors).toEqual([]);
});

test('user save preserves drafts on rejection and regenerates only after acceptance, retaining attachments', async ({ page }) => {
  const app = await mockChat(page);
  const field = await edit(page, 'user');
  await field.fill('Edited user\n**raw**');
  app.state.rejectEdits = true;
  await page.getByRole('button', { name: 'Save & Regenerate', exact: true }).click();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('Edited user\n**raw**');
  await expect(message(page, 'assistant').getByRole('heading', { name: 'Heading' })).toBeVisible();
  app.state.rejectEdits = false;
  await page.getByRole('button', { name: 'Save & Regenerate', exact: true }).click();
  await expect(page.locator('.edit-area')).toHaveCount(0);
  await expect(message(page, 'assistant')).toContainText('Regenerated answer');
  await expect(message(page, 'user').getByRole('link', { name: /report.txt/ })).toBeVisible();
  await expect.poll(() => app.drafts['chat-1']).toEqual({});
  expect(app.chatRequests.at(-1).edit_message_id).toBe('chat-1-user');
  expect(app.patches).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('a delayed assistant save cannot update another chat or clear its draft', async ({ page }) => {
  const app = await mockChat(page);
  let release;
  app.state.holdPatch = new Promise(resolve => { release = resolve; });
  await (await edit(page, 'assistant')).fill('Saved in chat 1');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => app.patches.length).toBe(1);
  await switchChat(page, 'Chat 2');
  await (await edit(page, 'assistant')).fill('Draft in chat 2');
  release();
  await expect.poll(() => app.drafts['chat-1']).toEqual({});
  await expect(message(page, 'assistant').locator('.edit-area')).toHaveValue('Draft in chat 2');
  await switchChat(page, 'Chat 1');
  await expect(page.locator('.edit-area')).toHaveCount(0);
  await expect(message(page, 'assistant')).toContainText('Saved in chat 1');
  expect(app.errors).toEqual([]);
});
