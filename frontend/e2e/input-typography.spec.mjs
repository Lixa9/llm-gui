import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';

async function mockApp(page) {
  let authenticated = true;
  const now = Date.now();
  const conversation = { id: 'chat-1', owner_sub: 'test', title: 'Test chat', model_id: 'mock', folder_id: null, created_at: now };
  const messages = ['user', 'assistant'].map(role => ({ id: `${role}-1`, conversation_id: 'chat-1', role, content: [{ type: 'text', text: 'Test message' }], status: 'done', model: role === 'assistant' ? 'mock' : null, timestamp: now }));
  const unexpected = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill(authenticated ? { json: { sub: 'test', name: 'Test', email: 'test@example.test', role: 'admin' } } : { status: 401, json: { error: 'Sign in' } });
    let data;
    if (path === '/api/auth/local-enabled') data = { enabled: true };
    else if (path === '/api/app') data = { name: 'LLM Chat', tagline: 'Test' };
    else if (path === '/api/preferences') data = { theme: 'light', default_model_id: 'mock', collapsed_folder_ids: '[]' };
    else if (path.startsWith('/api/preferences/')) data = {};
    else if (path === '/api/conversations/search') data = [];
    else if (path === '/api/conversations') data = [conversation];
    else if (path === '/api/folders') data = [{ id: 'folder-1', name: 'Test folder', owner_sub: 'test', parent_id: null, created_at: now }];
    else if (path === '/api/folders/folder-1') data = { id: 'folder-1', name: 'Test folder', owner_sub: 'test', parent_id: null, created_at: now };
    else if (path === '/api/models') data = [{ id: 'mock', display_name: 'Test model', allowed_roles: ['admin', 'user'] }];
    else if (path === '/api/presets') data = [{ id: 'preset-1', name: 'Test preset', owner_sub: 'test', base_model_id: 'mock', system_prompt: 'Test', created_at: now }];
    else if (path === '/api/prompts') data = [{ id: 'prompt-1', name: 'Test prompt', owner_sub: 'test', content: 'Test', created_at: now }];
    else if (path === '/api/automations') data = [{ id: 'auto-1', name: 'Test automation', owner_sub: 'test', definition: { interval: 1, unit: 'days', model: 'mock', system_prompt: '', user_prompt: 'Test' }, enabled: true, created_at: now }];
    else if (path.startsWith('/api/drafts/')) data = { text: '', attachments: [] };
    else if (path === '/api/uploads/formats') data = [];
    else if (path === '/api/conversations/chat-1/messages') data = messages;
    else if (path === '/api/conversations/chat-1/message-drafts') data = {};
    else if (path.startsWith('/api/conversations/chat-1/message-drafts/')) return route.fulfill({ status: 204 });
    else if (path === '/api/conversations/chat-1') data = conversation;
    else {
      unexpected.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected test request' } });
    }
    return route.fulfill({ json: data });
  });
  return { logout: () => { authenticated = false; }, unexpected };
}

function inkBounds(png, predicate) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  // Ignore the border and native search-clear/number-stepper affordances.
  for (let y = 4; y < png.height - 4; y++) for (let x = 4; x < Math.min(90, png.width - 4); x++) {
    const i = (y * png.width + x) * 4;
    if (predicate(png.data[i], png.data[i + 1], png.data[i + 2])) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { left, top, right, bottom, center: (top + bottom) / 2 };
}

async function nativeInk(field) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const png = PNG.sync.read(await field.screenshot({ caret: 'initial', animations: 'disabled' }));
    const caret = inkBounds(png, (r, g, b) => r > 160 && g < 100 && b < 100);
    const text = inkBounds(png, (r, g, b) => b > 60 && b - r > 35 && Math.abs(r - g) <= 3);
    if (caret) return { caret, text };
    // Restart caret blinking without committing rename fields on blur.
    await field.press('ArrowLeft');
    await field.press('ArrowRight');
  }
  return { caret: null, text: null };
}

const cases = [
  { name: 'default', zoom: 1 },
  { name: 'local fonts blocked and unusual system font', zoom: 1, blockLocal: true },
  { name: 'dark mode at 125 percent zoom', zoom: 1.25, dark: true },
];

for (const scenario of cases) test(`all editable fields: ${scenario.name}`, async ({ page, browserName }, testInfo) => {
  const app = await mockApp(page);
  // Match the deployed app's CSP, including its ban on data: font URLs.
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'" } });
  });
  const errors = [];
  const measurements = [];
  page.on('pageerror', error => errors.push(error.message));
  if (scenario.blockLocal) await page.addInitScript(() => {
    const NativeFontFace = window.FontFace;
    window.FontFace = new Proxy(NativeFontFace, {
      construct(target, args) {
        const face = Reflect.construct(target, args);
        if (typeof args[1] === 'string' && args[1].includes('local(')) face.load = () => Promise.reject(new DOMException('Local font access denied'));
        return face;
      },
    });
  });
  await page.goto('/#/chat/chat-1');
  await page.locator('.composer-textarea:not(:disabled)').waitFor();
  async function decoratePage() {
    await page.addStyleTag({ content: `
      *, *::before, *::after { animation: none !important; transition: none !important; }
      input::placeholder, textarea::placeholder { color: #0000ff !important; opacity: 1 !important; }
    ` });
    await page.evaluate(({ zoom, dark, blockLocal }) => {
      document.documentElement.style.zoom = String(zoom);
      if (dark) document.documentElement.dataset.theme = 'dark';
      if (blockLocal) document.documentElement.style.setProperty('--font-family', 'Unifont, serif');
      dispatchEvent(new Event('resize'));
    }, scenario);
  }
  await decoratePage();
  const pixelScale = scenario.zoom * await page.evaluate(() => devicePixelRatio);

  async function probe(selector, label, mono = false) {
    const field = page.locator(selector).first();
    await field.waitFor({ state: 'visible' });
    const original = await field.inputValue();
    const inputType = await field.getAttribute('type');
    const height = (await field.boundingBox()).height;
    const family = mono ? 'LLM Input Mono' : 'LLM Input Sans';
    for (const value of [inputType === 'number' ? '1' : 'H', '']) {
      await field.fill(value);
      // ModelPicker closes its popup 150 ms after blur. Wait until the next
      // field is unobscured; the popup can otherwise clip the top of its caret.
      if (!await field.evaluate(element => element.classList.contains('picker-input'))) {
        await expect(page.locator('.picker-dropdown')).toHaveCount(0);
      }
      await field.evaluate(element => {
        element.style.setProperty('color', '#0000ff', 'important');
        element.style.setProperty('-webkit-text-fill-color', '#0000ff', 'important');
        element.style.setProperty('caret-color', '#ff0000', 'important');
        if (element.type !== 'number') element.setSelectionRange(element.value.length, element.value.length);
      });
      await page.evaluate(() => document.fonts.ready);
      await field.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await field.evaluate(element => {
        const style = getComputedStyle(element);
        const context = document.createElement('canvas').getContext('2d');
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = context.measureText('H');
        const placeholder = context.measureText(element.placeholder || '');
        const placeholderOffset = (placeholder.actualBoundingBoxAscent - placeholder.actualBoundingBoxDescent - text.fontBoundingBoxAscent + text.fontBoundingBoxDescent) / 2;
        return { family: style.fontFamily, placeholder: element.placeholder || '', actualValue: element.value, placeholderOffset, offset: (text.actualBoundingBoxAscent - text.fontBoundingBoxAscent + text.fontBoundingBoxDescent) / 2, height: element.getBoundingClientRect().height, loaded: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family.replaceAll('"', '').replaceAll("'", '')) };
      });
      expect(metrics.family.split(',')[0].replaceAll('"', '').replaceAll("'", ''), label).toBe(family);
      expect(metrics.loaded, `${label}: bundled font loaded`).toContain(family);
      expect(Math.abs(metrics.offset), `${label}: balanced caret metrics`).toBeLessThanOrEqual(0.6);
      expect(Math.abs(metrics.height - height), `${label}: typing preserves field height`).toBeLessThanOrEqual(1);
      // Firefox's Playwright drawSnapshot API omits native carets. Check its
      // actual font metrics here; Linux display capture is documented below.
      if (browserName !== 'firefox') {
        const ink = await nativeInk(field);
        expect(ink.caret, `${label}: visible native caret (${JSON.stringify(ink)})`).not.toBeNull();
        if (value && inputType !== 'password') {
          expect(ink.text, `${label}: visible glyph`).not.toBeNull();
          expect(Math.abs(ink.caret.center - ink.text.center), `${label}: caret/glyph centers (${JSON.stringify(ink)})`).toBeLessThanOrEqual(1.1 * pixelScale);
        }
        if (!value && metrics.placeholder && ink.text) {
          const delta = ink.caret.center - ink.text.center;
          if (inputType === 'password') {
            // Password widgets can substitute a native masking glyph. Its
            // visible center matters; Canvas metrics for U+2022 do not apply.
            expect(Math.abs(delta), `${label}: caret/masking glyph center`).toBeLessThanOrEqual(1.5 * pixelScale);
          } else {
            expect(Math.abs(delta - metrics.placeholderOffset * pixelScale), `${label}: caret/placeholder baseline (${JSON.stringify(ink)})`).toBeLessThanOrEqual(1.1 * pixelScale);
          }
        }
        measurements.push({ label, value, ...metrics, ink });
      } else measurements.push({ label, value, ...metrics });
    }
    if (mono) {
      await field.fill('Ž Ỗ Ԁ');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => [...document.fonts].filter(font => font.family.includes('LLM Input') && font.status === 'error').map(font => font.family)), `${label}: all script subsets load under CSP`).toEqual([]);
    }
    await field.fill(original);
    await field.evaluate(element => { element.dataset.typographyChecked = 'true'; });
  }

  await probe('.search-input', 'chat search');
  await probe('.composer-textarea', 'message composer');
  await probe('.picker-input', 'chat model search');
  async function assertAllTextFieldsChecked() {
    const missing = await page.locator('input, textarea').evaluateAll(fields => fields.filter(field => !['checkbox', 'radio', 'range', 'file', 'submit', 'button', 'hidden'].includes(field.type) && field.getBoundingClientRect().width && field.getBoundingClientRect().height && !field.dataset.typographyChecked).map(field => field.id || field.className || field.type));
    expect(missing, 'every visible text input is covered').toEqual([]);
  }
  await assertAllTextFieldsChecked();
  const composer = page.locator('.composer-textarea');
  await composer.fill('Grüße ě Ỗ ξ Ж Ԁ א 世界 مرحبا 👋');
  await composer.evaluate(element => element.setSelectionRange(2, 5));
  expect(await composer.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([2, 5]);
  await composer.press('End');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('zweite Zeile');
  expect(await composer.inputValue()).toMatch(/\nzweite Zeile$/);
  await composer.fill('\n'.repeat(30) + 'H');
  await composer.evaluate(element => { element.setSelectionRange(element.value.length, element.value.length); element.scrollTop = element.scrollHeight; });
  expect(await composer.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  if (browserName !== 'firefox') {
    const { caret, text } = await nativeInk(composer);
    expect(caret).not.toBeNull(); expect(text).not.toBeNull();
    expect(caret.top).toBeLessThanOrEqual(text.top + pixelScale);
    expect(caret.bottom).toBeGreaterThanOrEqual(text.bottom - pixelScale);
  }
  await composer.fill('');

  for (const role of ['user', 'assistant']) {
    await page.locator(`.msg-${role}`).getByRole('button', { name: 'Edit', exact: true }).click();
    await probe('.edit-area', `edit ${role} message`);
    await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  }
  for (const [button, selector, label] of [
    ['Rename conversation', '.rename-input', 'rename chat'],
    ['Rename folder', '.rename-input', 'rename folder'],
    ['New folder', '.new-folder-input', 'create folder'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).first().click();
    await probe(selector, label);
    await page.locator(selector).press('Escape');
  }
  for (const [view, fields] of [
    ['Prompts', [['#pe-name', 'prompt name'], ['#pe-content', 'prompt content', true]]],
    ['Presets', [['#pr-name', 'preset name'], ['#pr-sysprompt', 'preset prompt', true]]],
    ['Automations', [['#ae-name', 'automation name'], ['#ae-interval', 'automation interval'], ['.picker-input', 'automation model search'], ['#ae-sysprompt', 'automation system prompt', true], ['#ae-userprompt', 'automation user prompt', true]]],
  ]) {
    await page.locator('.nav').getByRole('button', { name: view, exact: true }).click();
    for (const [selector, label, mono] of fields) await probe(selector, label, mono);
    await assertAllTextFieldsChecked();
  }
  app.logout();
  await page.reload();
  await page.locator('#login-username').waitFor();
  await decoratePage();
  await probe('#login-username', 'login username');
  await probe('#login-password', 'login password');
  expect(new Set(measurements.map(item => item.label)).size).toBe(19);
  await assertAllTextFieldsChecked();
  expect(app.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await testInfo.attach('input-metrics', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});
